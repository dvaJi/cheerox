//! A blocking native tokenizer with live JavaScript adapter calls. Its input and
//! callback waits release the same CPU permit used by all other native jobs.
use crate::{diagnostics::DiagnosticContext, runtime, NativeDocument};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::JsFunction;
use napi_derive::napi;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::io;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};

fn closed() -> Error {
    Error::new(Status::GenericFailure, "Native hook stream is closed")
}
fn interrupted() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "Native hook stream is closed")
}
type Reply = mpsc::Sender<Result<NativeDocument>>;
enum Message {
    Chunk(String, mpsc::Sender<Result<()>>),
    Finish(Reply),
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
            return Err(closed());
        }
        let result = self
            .sender
            .lock()
            .unwrap()
            .as_ref()
            .ok_or_else(closed)?
            .send(message)
            .map_err(|_| closed());
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
pub struct NativeHookStream {
    state: Arc<State>,
}
#[napi]
impl NativeHookStream {
    #[napi(constructor)]
    pub fn new(
        env: Env,
        is_document: bool,
        options_json: String,
        bridge: JsFunction,
    ) -> Result<Self> {
        Self::create(env, is_document, options_json, bridge, false)
    }

    #[napi]
    pub fn write(&self, chunk: String) -> Result<AsyncTask<HookWriteTask>> {
        Ok(AsyncTask::new(self.write_task(chunk)?))
    }
    #[napi]
    pub fn finish(&self) -> Result<AsyncTask<HookFinishTask>> {
        Ok(AsyncTask::new(self.finish_task()?))
    }
    #[napi]
    pub fn abort(&self) {
        self.state.cancelled.store(true, Ordering::Release);
        self.state.ended.store(true, Ordering::Release);
        self.state.sender.lock().unwrap().take();
        self.state.wake.notify_all();
    }
}
impl NativeHookStream {
    fn create(
        env: Env,
        is_document: bool,
        options_json: String,
        bridge: JsFunction,
        native: bool,
    ) -> Result<Self> {
        let options: Value = serde_json::from_str(&options_json).map_err(crate::json_error)?;
        let mut function: ThreadsafeFunction<String, ErrorStrategy::Fatal> = bridge
            .create_threadsafe_function(
                0,
                |context: napi::threadsafe_function::ThreadSafeCallContext<String>| {
                    Ok(vec![context.env.create_string(&context.value)?])
                },
            )?;
        function.unref(&env)?;
        let (tx, rx) = mpsc::sync_channel(2);
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancel = cancelled.clone();
        std::thread::Builder::new()
            .name("cheerox-hook-stream".into())
            .spawn(move || run(rx, worker_cancel, options, is_document, function, native))
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
        Ok(Self {
            state: Arc::new(State {
                sender: Mutex::new(Some(tx)),
                cancelled,
                ended: AtomicBool::new(false),
                issued: AtomicU64::new(0),
                turn: Mutex::new(0),
                wake: Condvar::new(),
            }),
        })
    }
    pub(crate) fn native(
        env: Env,
        is_document: bool,
        options_json: String,
        bridge: JsFunction,
    ) -> Result<Self> {
        Self::create(env, is_document, options_json, bridge, true)
    }
    pub(crate) fn write_task(&self, chunk: String) -> Result<HookWriteTask> {
        if self.state.ended.load(Ordering::Acquire) {
            return Err(closed());
        }
        let sequence = self.state.issued.fetch_add(1, Ordering::Relaxed);
        Ok(HookWriteTask {
            state: self.state.clone(),
            sequence,
            chunk: Some(chunk),
        })
    }
    pub(crate) fn finish_task(&self) -> Result<HookFinishTask> {
        if self.state.ended.swap(true, Ordering::AcqRel) {
            return Err(closed());
        }
        let sequence = self.state.issued.fetch_add(1, Ordering::Relaxed);
        Ok(HookFinishTask {
            state: self.state.clone(),
            sequence,
        })
    }
}
pub struct HookWriteTask {
    state: Arc<State>,
    sequence: u64,
    chunk: Option<String>,
}
#[napi]
impl Task for HookWriteTask {
    type Output = ();
    type JsValue = ();
    fn compute(&mut self) -> Result<()> {
        let (tx, rx) = mpsc::channel();
        self.state.send(
            self.sequence,
            Message::Chunk(self.chunk.take().unwrap_or_default(), tx),
        )?;
        rx.recv().map_err(|_| closed())?
    }
    fn resolve(&mut self, _: Env, _: ()) -> Result<()> {
        Ok(())
    }
}
pub struct HookFinishTask {
    state: Arc<State>,
    sequence: u64,
}
#[napi]
impl Task for HookFinishTask {
    type Output = NativeDocument;
    type JsValue = NativeDocument;
    fn compute(&mut self) -> Result<NativeDocument> {
        let (tx, rx) = mpsc::channel();
        self.state.send(self.sequence, Message::Finish(tx))?;
        rx.recv().map_err(|_| closed())?
    }
    fn resolve(&mut self, _: Env, output: NativeDocument) -> Result<NativeDocument> {
        Ok(output)
    }
}

struct Budget(RefCell<Option<runtime::Permit>>);
impl Budget {
    fn pause(&self) {
        self.0.borrow_mut().take();
    }
    fn resume(&self) -> Result<()> {
        if self.0.borrow().is_none() {
            *self.0.borrow_mut() = Some(runtime::permit()?);
        }
        Ok(())
    }
}
struct Input {
    receiver: mpsc::Receiver<Message>,
    buffer: Vec<u8>,
    position: usize,
    pending: Option<(String, usize)>,
    ack: Option<mpsc::Sender<Result<()>>>,
    finish: Rc<RefCell<Option<Reply>>>,
    eof: bool,
    budget: Rc<Budget>,
    context: Rc<DiagnosticContext>,
    cancelled: Arc<AtomicBool>,
}
impl Input {
    fn available(&mut self, length: usize) -> io::Result<bool> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(interrupted());
        }
        while self.buffer.len() - self.position < length && !self.eof {
            if self.position > 0 {
                self.buffer.drain(..self.position);
                self.position = 0;
            }
            if self.cancelled.load(Ordering::Acquire) {
                if let Some(ack) = self.ack.take() {
                    let _ = ack.send(Err(closed()));
                }
                return Err(interrupted());
            }
            if let Some((chunk, position)) = &mut self.pending {
                self.budget
                    .resume()
                    .map_err(|error| io::Error::other(error.to_string()))?;
                let mut end = (*position + 16 * 1024).min(chunk.len());
                while !chunk.is_char_boundary(end) {
                    end -= 1;
                }
                let part = &chunk[*position..end];
                self.context.append_source(part);
                self.buffer.extend_from_slice(part.as_bytes());
                *position = end;
                if end == chunk.len() {
                    self.pending = None;
                }
                continue;
            }
            self.budget.pause();
            // Retain only bounded tokenizer lookahead across the acknowledgment.
            if let Some(ack) = self.ack.take() {
                let _ = ack.send(Ok(()));
            }
            let message = self.receiver.recv().map_err(|_| interrupted())?;
            self.budget
                .resume()
                .map_err(|error| io::Error::other(error.to_string()))?;
            match message {
                Message::Chunk(chunk, ack) => {
                    self.pending = Some((chunk, 0));
                    self.ack = Some(ack);
                }
                Message::Finish(reply) => {
                    *self.finish.borrow_mut() = Some(reply);
                    self.eof = true;
                }
            }
        }
        Ok(self.buffer.len() - self.position >= length)
    }
}
impl html5gum::Reader for Input {
    type Error = io::Error;
    fn read_byte(&mut self) -> io::Result<Option<u8>> {
        if self.available(1)? {
            let byte = self.buffer[self.position];
            self.position += 1;
            Ok(Some(byte))
        } else {
            Ok(None)
        }
    }
    fn try_read_string(&mut self, source: &[u8], case_sensitive: bool) -> io::Result<bool> {
        if !self.available(source.len())? {
            return Ok(false);
        }
        let equal = self.buffer[self.position..]
            .iter()
            .copied()
            .take(source.len())
            .zip(source.iter().copied())
            .all(|(a, b)| {
                if case_sensitive {
                    a == b
                } else {
                    a.eq_ignore_ascii_case(&b)
                }
            });
        if equal {
            self.position += source.len();
        }
        Ok(equal)
    }
    fn read_until<'a>(
        &'a mut self,
        needle: &[u8],
        _: &'a mut [u8; 4],
    ) -> io::Result<Option<&'a [u8]>> {
        if !self.available(1)? {
            return Ok(None);
        }
        let start = self.position;
        let bytes = &self.buffer[start..];
        let count = bytes
            .iter()
            .position(|byte| needle.contains(byte))
            .map_or(bytes.len(), |at| if at == 0 { 1 } else { at });
        self.position += count;
        Ok(Some(&self.buffer[start..self.position]))
    }
}
impl Drop for Input {
    fn drop(&mut self) {
        if let Some(ack) = self.ack.take() {
            let _ = ack.send(if self.cancelled.load(Ordering::Acquire) {
                Err(closed())
            } else {
                Ok(())
            });
        }
    }
}
fn run(
    receiver: mpsc::Receiver<Message>,
    cancelled: Arc<AtomicBool>,
    options: Value,
    is_document: bool,
    function: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
    native: bool,
) {
    let budget = Rc::new(Budget(RefCell::new(None)));
    let keep_source = options.get("sourceCodeLocationInfo") == Some(&Value::Bool(true));
    let track_positions =
        keep_source || native || options.get("__collectParseErrors") == Some(&Value::Bool(true));
    let context = Rc::new(DiagnosticContext::streaming_with_source_mode(
        keep_source,
        track_positions,
    ));
    let finish = Rc::new(RefCell::new(None));
    let input = Input {
        receiver,
        buffer: Vec::new(),
        position: 0,
        pending: None,
        ack: None,
        finish: finish.clone(),
        eof: false,
        budget: budget.clone(),
        context: context.clone(),
        cancelled: cancelled.clone(),
    };
    let callback_budget = budget.clone();
    let callback_cancel = cancelled.clone();
    let call = Box::new(move |method: &str, args: Value| -> Result<Value> {
        callback_budget.pause();
        if callback_cancel.load(Ordering::Acquire) {
            return Err(closed());
        }
        let (tx, rx) = mpsc::channel();
        let status = function.call_with_return_value(
            json!({"method":method,"args":args}).to_string(),
            ThreadsafeFunctionCallMode::NonBlocking,
            move |reply: String| {
                let _ = tx.send(reply);
                Ok(())
            },
        );
        if status != Status::Ok {
            return Err(Error::new(status, "Could not invoke the parser hook"));
        }
        let text = rx.recv().map_err(|_| closed())?;
        callback_budget.resume()?;
        let value: Value = serde_json::from_str(&text).map_err(crate::json_error)?;
        if value.get("__cheeroxHookError") == Some(&Value::Bool(true)) {
            callback_cancel.store(true, Ordering::Release);
            return Err(Error::new(
                Status::GenericFailure,
                "User parser hook failed",
            ));
        }
        Ok(value)
    });
    let result = (|| {
        budget.resume()?;
        if native {
            let sink = crate::sink::CompatibleSink::with_errors(if is_document {
                scraper::Html::new_document()
            } else {
                scraper::Html::new_fragment()
            });
            let errors = RefCell::new(Vec::new());
            let failure = RefCell::new(None);
            let html = crate::diagnostics::parse_reader_with_sink(
                input,
                is_document,
                &options,
                sink,
                context.clone(),
                |sink, context| {
                    for message in sink.take_errors() {
                        if let Some(error) = context.error(&message) {
                            errors.borrow_mut().push(error.clone());
                            if failure.borrow().is_none() {
                                if let Err(error) = call("__parseError", json!([error])) {
                                    *failure.borrow_mut() = Some(error);
                                    cancelled.store(true, Ordering::Release);
                                }
                            }
                        }
                    }
                },
            )
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
            if let Some(error) = failure.into_inner() {
                return Err(error);
            }
            let source = (options.get("sourceCodeLocationInfo") == Some(&Value::Bool(true)))
                .then(|| context.source_between(0, context.source_len()));
            let mut parser_options = options;
            parser_options["__collectParseErrors"] = Value::Bool(false);
            let document = NativeDocument::from_html(html, is_document, parser_options, source);
            document.set_diagnostic_records(errors.into_inner());
            Ok(document)
        } else {
            crate::hook_sink::parse_reader(input, options, is_document, context, call)
        }
    })();
    budget.pause();
    cancelled.store(true, Ordering::Release);
    if let Some(reply) = finish.borrow_mut().take() {
        let _ = reply.send(result);
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocking_reader_preserves_tokens_errors_and_backpressure_across_chunks() {
        let source = "<!DOCTYPE html>😀\r\n<p a a='x'>&#0;&amp;<!-- c --></p><script>A</script>";
        let expected =
            crate::NativeDocument::parse_options(source, true, json!({}), None).outer_html(vec![0]);
        let expected_errors = crate::diagnostics::collect(source, true, &json!({}));
        let (tx, rx) = mpsc::sync_channel(2);
        let worker = std::thread::spawn(move || {
            let budget = Rc::new(Budget(RefCell::new(None)));
            let context = Rc::new(DiagnosticContext::streaming(true));
            let finish = Rc::new(RefCell::new(None));
            let input = Input {
                receiver: rx,
                buffer: Vec::new(),
                position: 0,
                pending: None,
                ack: None,
                finish: finish.clone(),
                eof: false,
                budget: budget.clone(),
                context: context.clone(),
                cancelled: Arc::new(AtomicBool::new(false)),
            };
            budget.resume().unwrap();
            let mut errors = Vec::new();
            let html = crate::diagnostics::parse_reader_with_sink(
                input,
                true,
                &json!({}),
                crate::sink::CompatibleSink::with_errors(scraper::Html::new_document()),
                context,
                |sink, context| {
                    for message in sink.take_errors() {
                        if let Some(error) = context.error(&message) {
                            errors.push(error);
                        }
                    }
                },
            )
            .unwrap();
            budget.pause();
            let document = NativeDocument::from_html(html, true, json!({}), None);
            let output = document.outer_html(vec![0]);
            let reply = finish.borrow_mut().take().unwrap();
            reply.send(Ok(document)).unwrap();
            (output, errors)
        });
        for ch in source.chars() {
            let (ack, done) = mpsc::channel();
            tx.send(Message::Chunk(ch.to_string(), ack)).unwrap();
            done.recv().unwrap().unwrap();
        }
        let (reply, done) = mpsc::channel();
        tx.send(Message::Finish(reply)).unwrap();
        done.recv().unwrap().unwrap();
        let (output, errors) = worker.join().unwrap();
        assert_eq!(output, expected);
        assert_eq!(errors, expected_errors);
    }
}
