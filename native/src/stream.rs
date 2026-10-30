//! Incremental off-thread parsing. The bounded channel acknowledges each chunk
//! only after parsing it, and shares the process CPU permits with batch work.
use crate::{arena, runtime, sink, NativeDocument};
use html5ever::tendril::TendrilSink;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use scraper::Html;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};

fn stopped() -> Error {
    Error::new(Status::GenericFailure, "Native parser stream is closed")
}
enum Message {
    Chunk(String, mpsc::Sender<Result<()>>),
    Finish(mpsc::Sender<Result<NativeDocument>>),
}
struct State {
    sender: Mutex<Option<mpsc::SyncSender<Message>>>,
    cancelled: Arc<AtomicBool>,
    ended: AtomicBool,
    issued: AtomicU64,
    turn: Mutex<u64>,
    wake: Condvar,
}
impl State {
    fn send(&self, sequence: u64, message: Message) -> Result<()> {
        let mut turn = self.turn.lock().unwrap();
        while *turn != sequence && !self.cancelled.load(Ordering::Acquire) {
            turn = self.wake.wait(turn).unwrap();
        }
        if self.cancelled.load(Ordering::Acquire) {
            return Err(stopped());
        }
        let result = self
            .sender
            .lock()
            .unwrap()
            .as_ref()
            .ok_or_else(stopped)?
            .send(message)
            .map_err(|_| stopped());
        *turn += 1;
        self.wake.notify_all();
        result
    }
}
impl Drop for State {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        self.sender.get_mut().unwrap().take();
    }
}
#[napi]
pub struct NativeStream {
    state: Option<Arc<State>>,
    threaded: Option<crate::hook_stream::NativeHookStream>,
}
#[napi]
impl NativeStream {
    #[napi(constructor)]
    pub fn new(
        env: Env,
        options_json: String,
        is_document: Option<bool>,
        error_callback: Option<napi::JsFunction>,
    ) -> Result<Self> {
        if let Some(callback) = error_callback {
            return Ok(Self {
                state: None,
                threaded: Some(crate::hook_stream::NativeHookStream::native(
                    env,
                    is_document.unwrap_or(true),
                    options_json,
                    callback,
                )?),
            });
        }
        let options: Value = serde_json::from_str(&options_json).map_err(crate::json_error)?;
        let options = arena::normalized_options(options);
        let (sender, receiver) = mpsc::sync_channel(2);
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancel = cancelled.clone();
        std::thread::Builder::new()
            .name("rusteerio-stream".into())
            .spawn(move || {
                run(
                    receiver,
                    worker_cancel,
                    options,
                    is_document.unwrap_or(true),
                )
            })
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
        Ok(Self {
            threaded: None,
            state: Some(Arc::new(State {
                sender: Mutex::new(Some(sender)),
                cancelled,
                ended: AtomicBool::new(false),
                issued: AtomicU64::new(0),
                turn: Mutex::new(0),
                wake: Condvar::new(),
            })),
        })
    }
    #[napi]
    pub fn write(&self, chunk: String) -> Result<AsyncTask<WriteTask>> {
        if let Some(threaded) = &self.threaded {
            return Ok(AsyncTask::new(WriteTask {
                state: None,
                sequence: 0,
                chunk: None,
                threaded: Some(threaded.write_task(chunk)?),
            }));
        }
        let state = self.state.as_ref().unwrap();
        if state.ended.load(Ordering::Acquire) {
            return Err(stopped());
        }
        let sequence = state.issued.fetch_add(1, Ordering::Relaxed);
        Ok(AsyncTask::new(WriteTask {
            state: Some(state.clone()),
            threaded: None,
            sequence,
            chunk: Some(chunk),
        }))
    }
    #[napi]
    pub fn finish(&self) -> Result<AsyncTask<FinishTask>> {
        if let Some(threaded) = &self.threaded {
            return Ok(AsyncTask::new(FinishTask {
                state: None,
                sequence: 0,
                threaded: Some(threaded.finish_task()?),
            }));
        }
        let state = self.state.as_ref().unwrap();
        if state.ended.swap(true, Ordering::AcqRel) {
            return Err(stopped());
        }
        let sequence = state.issued.fetch_add(1, Ordering::Relaxed);
        Ok(AsyncTask::new(FinishTask {
            state: Some(state.clone()),
            threaded: None,
            sequence,
        }))
    }
    #[napi]
    pub fn abort(&self) {
        if let Some(threaded) = &self.threaded {
            threaded.abort();
            return;
        }
        let state = self.state.as_ref().unwrap();
        state.cancelled.store(true, Ordering::Release);
        state.ended.store(true, Ordering::Release);
        state.sender.lock().unwrap().take();
        state.wake.notify_all();
    }
}
pub struct WriteTask {
    state: Option<Arc<State>>,
    threaded: Option<crate::hook_stream::HookWriteTask>,
    sequence: u64,
    chunk: Option<String>,
}
#[napi]
impl Task for WriteTask {
    type Output = ();
    type JsValue = ();
    fn compute(&mut self) -> Result<()> {
        if let Some(task) = &mut self.threaded {
            return task.compute();
        }
        let (tx, rx) = mpsc::channel();
        self.state.as_ref().unwrap().send(
            self.sequence,
            Message::Chunk(self.chunk.take().unwrap_or_default(), tx),
        )?;
        rx.recv().map_err(|_| stopped())?
    }
    fn resolve(&mut self, _: Env, _: ()) -> Result<()> {
        Ok(())
    }
}
pub struct FinishTask {
    state: Option<Arc<State>>,
    threaded: Option<crate::hook_stream::HookFinishTask>,
    sequence: u64,
}
#[napi]
impl Task for FinishTask {
    type Output = NativeDocument;
    type JsValue = NativeDocument;
    fn compute(&mut self) -> Result<NativeDocument> {
        if let Some(task) = &mut self.threaded {
            return task.compute();
        }
        let (tx, rx) = mpsc::channel();
        self.state
            .as_ref()
            .unwrap()
            .send(self.sequence, Message::Finish(tx))?;
        rx.recv().map_err(|_| stopped())?
    }
    fn resolve(&mut self, _: Env, output: NativeDocument) -> Result<NativeDocument> {
        Ok(output)
    }
}
enum Parser {
    Html(Box<html5ever::driver::Parser<sink::CompatibleSink>>),
    Xml(Box<arena::XmlStream>),
}
fn run(
    receiver: mpsc::Receiver<Message>,
    cancelled: Arc<AtomicBool>,
    options: Value,
    is_document: bool,
) {
    let parser = if arena::xml_mode(&options)
        || options.get("_useHtmlParser2") == Some(&Value::Bool(true))
    {
        Parser::Xml(Box::new(arena::XmlStream::new(options.clone())))
    } else {
        let parse_options = html5ever::driver::ParseOpts {
            tokenizer: html5ever::tokenizer::TokenizerOpts {
                discard_bom: false,
                rusteerio_codec: options.get("__utf16Codec") == Some(&Value::Bool(true)),
                ..Default::default()
            },
            tree_builder: html5ever::tree_builder::TreeBuilderOpts {
                scripting_enabled: options.get("scriptingEnabled") != Some(&Value::Bool(false)),
                ..Default::default()
            },
        };
        Parser::Html(Box::new(if is_document {
            html5ever::driver::parse_document(
                sink::CompatibleSink::new(Html::new_document()),
                parse_options,
            )
        } else {
            html5ever::driver::parse_fragment(
                sink::CompatibleSink::new(Html::new_fragment()),
                parse_options,
                html5ever::QualName::new(
                    None,
                    html5ever::Namespace::from(crate::HTML_NS),
                    html5ever::LocalName::from("template"),
                ),
                Vec::new(),
                false,
            )
        }))
    };
    let mut parser = Some(parser);
    let capture = options.get("sourceCodeLocationInfo") == Some(&Value::Bool(true))
        || options.get("__collectParseErrors") == Some(&Value::Bool(true));
    let mut source = capture.then(String::new);
    while let Ok(message) = receiver.recv() {
        if cancelled.load(Ordering::Acquire) {
            break;
        }
        match message {
            Message::Chunk(chunk, ack) => {
                let result = (|| {
                    let _permit = runtime::permit()?;
                    if let Some(source) = &mut source {
                        source.push_str(&chunk);
                    }
                    match parser.as_mut().unwrap() {
                        Parser::Html(parser) => parser.process(chunk.into()),
                        Parser::Xml(parser) => parser.feed(&chunk, false),
                    }
                    Ok(())
                })();
                let failed = result.is_err();
                let _ = ack.send(result);
                if failed {
                    break;
                }
            }
            Message::Finish(reply) => {
                let result = (|| {
                    let _permit = runtime::permit()?;
                    Ok(match parser.take().unwrap() {
                        Parser::Html(parser) => {
                            NativeDocument::from_html(parser.finish(), is_document, options, source)
                        }
                        Parser::Xml(mut parser) => {
                            parser.feed("", true);
                            NativeDocument::from_arena(parser.arena, options)
                        }
                    })
                })();
                let _ = reply.send(result);
                break;
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incremental_html_and_xml_match_one_shot_across_every_boundary() {
        for options in [
            serde_json::json!({}),
            serde_json::json!({"xmlMode":true}),
            serde_json::json!({"_useHtmlParser2":true}),
        ] {
            let source="<section a='A&amp;B'>😀 &amp; X<!-- hi --><script>1<2&&3</scriptx>4</script><b>fin</b></section>";
            let expected = NativeDocument::parse_options(source, true, options.clone(), None)
                .outer_html(vec![0]);
            for split in (0..=source.len()).filter(|index| source.is_char_boundary(*index)) {
                let (tx, rx) = mpsc::sync_channel(2);
                let cancel = Arc::new(AtomicBool::new(false));
                let opts = options.clone();
                let thread = std::thread::spawn(move || run(rx, cancel, opts, true));
                for chunk in [&source[..split], &source[split..]] {
                    let (ack, done) = mpsc::channel();
                    tx.send(Message::Chunk(chunk.into(), ack)).unwrap();
                    done.recv().unwrap().unwrap();
                }
                let (reply, result) = mpsc::channel();
                tx.send(Message::Finish(reply)).unwrap();
                let actual = result.recv().unwrap().unwrap().outer_html(vec![0]);
                thread.join().unwrap();
                assert_eq!(actual, expected, "split {split}, options {options}");
            }
        }
    }
}
