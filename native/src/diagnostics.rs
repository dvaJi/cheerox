//! WHATWG tokenizer diagnostics coupled to the real HTML5 tree builder.
//!
//! The tokenizer reports source-byte spans. The adapter converts them to
//! parse5's UTF-16 offsets and filters html5ever's additional recovery warnings.
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;

use html5ever::tokenizer::{
    states::RawKind, Doctype, Tag, TagKind, Token as TreeToken, TokenSink, TokenSinkResult,
};
use html5ever::tree_builder::{TreeBuilder, TreeBuilderOpts, TreeSink};
use html5ever::{Attribute, LocalName, Namespace, QualName};
use html5gum::emitters::ForwardingEmitter;
use html5gum::{DefaultEmitter, Emitter, Error, Span, State, Token, Tokenizer};
use scraper::Html;
use serde_json::{json, Value};

use crate::sink::CompatibleSink;

struct PositionedEmitter {
    inner: DefaultEmitter<usize>,
    foreign: Rc<Cell<bool>>,
    context: Rc<DiagnosticContext>,
    position: usize,
    text_kind: Option<u8>,
    text_end: usize,
    boundaries: VecDeque<usize>,
    deferred_text: Option<Token<usize>>,
    queued: Option<Token<usize>>,
    raw_queue: VecDeque<Token<usize>>,
    eof: bool,
}
fn character_kind(byte: u8) -> u8 {
    match byte {
        0 => 0,
        b' ' | b'\t' | b'\n' | b'\r' | 12 => 1,
        _ => 2,
    }
}
impl PositionedEmitter {
    fn dispatch(&mut self, token: Token<usize>) -> Token<usize> {
        match &token {
            Token::String(text) => self.context.text_non_whitespace.set(
                text.value
                    .iter()
                    .any(|byte| character_kind(*byte) == 2)
                    .then_some(text.span.start),
            ),
            Token::Error(_) => {}
            _ => {
                self.text_kind = None;
                self.text_end = self.position;
            }
        }
        token
    }
}
impl ForwardingEmitter for PositionedEmitter {
    type Token = Token<usize>;
    fn inner(&mut self) -> &mut impl Emitter<Token = Self::Token> {
        &mut self.inner
    }
    fn adjusted_current_node_present_but_not_in_html_namespace(&mut self) -> bool {
        self.foreign.get()
    }
    fn cheerox_codec(&mut self) -> bool {
        self.context.codec_enabled()
    }
    fn move_position(&mut self, offset: isize) {
        self.position = self.position.checked_add_signed(offset).unwrap();
        Emitter::move_position(&mut self.inner, offset);
    }
    fn init_string(&mut self) {
        if self.text_kind.is_none() {
            self.text_end = self.position;
        }
        Emitter::init_string(&mut self.inner);
    }
    fn emit_string(&mut self, characters: &[u8]) {
        let raw_start = self.text_end;
        let raw = self.context.source_between(raw_start, self.position);
        let direct = raw.as_bytes() == characters;
        let mut index = 0;
        while index < characters.len() {
            let kind = character_kind(characters[index]);
            let mut end = index + 1;
            while end < characters.len() && character_kind(characters[end]) == kind {
                end += 1;
            }
            let start_position = if direct { raw_start + index } else { raw_start };
            let end_position = if direct {
                raw_start + end
            } else {
                self.position
            };
            if self.text_kind.is_some_and(|previous| previous != kind) {
                self.boundaries.push_back(start_position);
                Emitter::init_comment(&mut self.inner); // Flush the completed character run.
                let delta = start_position as isize - self.position as isize;
                Emitter::move_position(&mut self.inner, delta);
                Emitter::init_string(&mut self.inner);
                Emitter::move_position(&mut self.inner, -delta);
            }
            self.text_kind = Some(kind);
            let delta = end_position as isize - self.position as isize;
            Emitter::move_position(&mut self.inner, delta);
            Emitter::emit_string(&mut self.inner, &characters[index..end]);
            Emitter::move_position(&mut self.inner, -delta);
            index = end;
        }
        self.text_end = self.position;
    }
    fn emit_char_ref(&mut self, characters: &[u8], is_attribute: bool) {
        let encoded;
        let characters = if self.context.codec_enabled() && characters.contains(&0xee) {
            encoded = crate::codec::encode_literal(&text(characters));
            encoded.as_bytes()
        } else {
            characters
        };
        if is_attribute {
            Emitter::push_attribute_value(&mut self.inner, characters);
        } else {
            Emitter::emit_string(self, characters);
        }
    }
    fn pop_token(&mut self) -> Option<Self::Token> {
        if let Some(token) = self.queued.take() {
            return Some(self.dispatch(token));
        }
        while let Some(token) = self
            .raw_queue
            .pop_front()
            .or_else(|| Emitter::pop_token(&mut self.inner))
        {
            if let Token::Error(error) = &token {
                if matches!(
                    error.value,
                    Error::ControlCharacterInInputStream
                        | Error::NoncharacterInInputStream
                        | Error::SurrogateInInputStream
                ) {
                    let point = error.span.start.saturating_sub(1);
                    let mut prior = VecDeque::new();
                    let mut remaining = VecDeque::new();
                    while let Some(next) = self
                        .raw_queue
                        .pop_front()
                        .or_else(|| Emitter::pop_token(&mut self.inner))
                    {
                        if matches!(&next,Token::String(text) if self.boundaries.contains(&text.span.end) && text.span.end<=point)
                        {
                            prior.push_back(next);
                        } else {
                            remaining.push_back(next);
                        }
                    }
                    if !prior.is_empty() {
                        prior.push_back(token);
                        prior.append(&mut remaining);
                        self.raw_queue = prior;
                        continue;
                    }
                    self.raw_queue = remaining;
                }
            }
            match &token {
                Token::String(text) if self.boundaries.front() == Some(&text.span.end) => {
                    self.boundaries.pop_front();
                    return Some(self.dispatch(token));
                }
                Token::String(_) => self.deferred_text = Some(token),
                Token::Error(_) => return Some(token),
                _ => {
                    if let Some(text) = self.deferred_text.take() {
                        self.queued = Some(token);
                        return Some(self.dispatch(text));
                    }
                    return Some(self.dispatch(token));
                }
            }
        }
        if self.eof {
            self.deferred_text.take().map(|token| self.dispatch(token))
        } else {
            None
        }
    }
    fn emit_eof(&mut self) {
        Emitter::emit_eof(&mut self.inner);
        self.eof = true;
    }
    fn emit_error(&mut self, error: Error) {
        // html5gum validates fast-path byte chunks before advancing its emitter
        // position. Recover each input-code-point position from the same bytes.
        if let Some(point) = self.context.input_error_offset(error) {
            let delta = (point + 1) as isize - self.position as isize;
            Emitter::move_position(&mut self.inner, delta);
            Emitter::emit_error(&mut self.inner, error);
            Emitter::move_position(&mut self.inner, -delta);
        } else {
            Emitter::emit_error(&mut self.inner, error);
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Point {
    line: usize,
    column: usize,
    offset: usize,
}
struct Checkpoint {
    byte: usize,
    point: Point,
    constant: bool,
}
struct Positions {
    checkpoints: Vec<Checkpoint>,
    length: usize,
    last: Point,
    previous_cr: bool,
    codec: bool,
    escaped: bool,
}
impl Positions {
    fn new(source: &str) -> Self {
        let point = Point {
            line: 1,
            column: 1,
            offset: 0,
        };
        let mut positions = Self {
            checkpoints: vec![Checkpoint {
                byte: 0,
                point,
                constant: false,
            }],
            length: 0,
            last: point,
            previous_cr: false,
            codec: false,
            escaped: false,
        };
        positions.append(source);
        positions
    }
    fn checkpoint(&mut self, byte: usize, point: Point, constant: bool) {
        if self
            .checkpoints
            .last()
            .is_some_and(|entry| entry.byte == byte)
        {
            let entry = self.checkpoints.last_mut().unwrap();
            entry.point = point;
            entry.constant = constant;
        } else {
            self.checkpoints.push(Checkpoint {
                byte,
                point,
                constant,
            });
        }
    }
    fn append(&mut self, source: &str) {
        let base = self.length;
        let mut point = self.last;
        for (index, character) in source.char_indices() {
            if !character.is_ascii() {
                self.checkpoint(base + index, point, true);
            }
            let width = if self.codec && !self.escaped && character == crate::codec::ESCAPE {
                self.escaped = true;
                0
            } else {
                self.escaped = false;
                character.len_utf16()
            };
            point.offset += width;
            if character == '\r' {
                point.line += 1;
                point.column = 1;
            } else if character == '\n' {
                if !self.previous_cr {
                    point.line += 1;
                }
                point.column = 1;
            } else {
                point.column += width;
            }
            self.previous_cr = character == '\r';
            if !character.is_ascii() || matches!(character, '\r' | '\n') {
                self.checkpoint(base + index + character.len_utf8(), point, false);
            }
        }
        self.length += source.len();
        self.last = point;
    }
    fn point(&self, offset: usize) -> Point {
        let offset = offset.min(self.length);
        let index = self
            .checkpoints
            .partition_point(|entry| entry.byte <= offset)
            .saturating_sub(1);
        let entry = &self.checkpoints[index];
        let mut point = entry.point;
        if !entry.constant {
            let delta = offset - entry.byte;
            point.offset += delta;
            point.column += delta;
        }
        point
    }
    fn record(&self, code: &str, start: usize, end: usize) -> Value {
        let start = self.point(start);
        let end = self.point(end);
        json!({"code":code,"startLine":start.line,"startCol":start.column,"startOffset":start.offset,
            "endLine":end.line,"endCol":end.column,"endOffset":end.offset})
    }
}

#[derive(Clone, Copy)]
enum Kind<'a> {
    Start(&'a str),
    End(&'a str),
    Text,
    Comment,
    Doctype,
    Eof,
}

fn tree_code(message: &str, kind: Kind<'_>) -> Option<&'static str> {
    if message.contains("insertion mode Initial") {
        return Some("missing-doctype");
    }
    if message.starts_with("Bad DOCTYPE") {
        return Some("non-conforming-doctype");
    }
    if message.starts_with("DOCTYPE in")
        && ["BeforeHead", "InHead", "AfterHead"]
            .iter()
            .any(|mode| message.contains(mode))
    {
        return Some("misplaced-doctype");
    }
    if message == "Unacknowledged self-closing tag" {
        return Some("non-void-html-element-start-tag-with-trailing-solidus");
    }
    if message.contains("Unexpected open element while closing") && message.contains("template") {
        return Some("closing-of-element-with-open-child-elements");
    }
    if message.contains("insertion mode Text") && matches!(kind, Kind::Eof) {
        return Some("eof-in-element-that-can-contain-only-text");
    }
    if message.contains("insertion mode InHeadNoscript") {
        return Some(match kind {
            Kind::Start("noscript") => "nested-noscript-in-head",
            Kind::Start("head") => "misplaced-start-tag-for-head-element",
            Kind::End(name) if name != "br" => "end-tag-without-matching-open-element",
            Kind::Eof => "open-elements-left-after-eof",
            _ => "disallowed-content-in-noscript-in-head",
        });
    }
    if matches!(kind, Kind::End("template")) {
        return None;
    }
    if message.contains("insertion mode BeforeHead") && matches!(kind, Kind::End(_)) {
        return Some("end-tag-without-matching-open-element");
    }
    if message.contains("insertion mode InHead") || message.contains("insertion mode AfterHead") {
        return match kind {
            Kind::Start("head") => Some("misplaced-start-tag-for-head-element"),
            Kind::Start(_) if message.contains("insertion mode AfterHead") => {
                Some("abandoned-head-element-child")
            }
            Kind::End(_) => Some("end-tag-without-matching-open-element"),
            _ => None,
        };
    }
    None
}

fn token_error_offset(source: &str, error: Error, span: Span<usize>) -> usize {
    let code = error.as_str();
    if code.starts_with("eof-") {
        return span.start.min(source.len());
    }
    if matches!(
        error,
        Error::MissingSemicolonAfterCharacterReference
            | Error::AbsenceOfDigitsInNumericCharacterReference
            | Error::NullCharacterReference
            | Error::SurrogateCharacterReference
            | Error::CharacterReferenceOutsideUnicodeRange
            | Error::NoncharacterCharacterReference
            | Error::ControlCharacterReference
    ) {
        let mut boundary = span.start.min(source.len());
        while !source.is_char_boundary(boundary) {
            boundary -= 1;
        }
        if let Some(amp) = source[..boundary].rfind('&') {
            if let Some((end, _, _)) = character_reference(source, amp) {
                return end;
            }
        }
    }
    if error == Error::DuplicateAttribute {
        return span.end.min(source.len());
    }
    // State-machine errors follow a consumed byte; parse5 points at the current
    // code point. Entity errors above instead point at the consumed reference.
    span.start.saturating_sub(1)
}

fn character_reference(source: &str, amp: usize) -> Option<(usize, u32, u32)> {
    let bytes = source.as_bytes();
    let mut index = amp + 1;
    if bytes.get(index) == Some(&b'#') {
        index += 1;
        let hexadecimal = matches!(bytes.get(index), Some(b'x' | b'X'));
        if hexadecimal {
            index += 1;
        }
        let start = index;
        while bytes.get(index).is_some_and(|byte| {
            if hexadecimal {
                byte.is_ascii_hexdigit()
            } else {
                byte.is_ascii_digit()
            }
        }) {
            index += 1;
        }
        if index == start {
            return Some((index, 0, 0));
        }
        let number = u32::from_str_radix(&source[start..index], if hexadecimal { 16 } else { 10 })
            .unwrap_or(0);
        if bytes.get(index) == Some(&b';') {
            index += 1;
        }
        return Some((index, number, 0));
    }
    let start = index;
    while bytes.get(index).is_some_and(u8::is_ascii_alphanumeric) {
        index += 1;
    }
    if bytes.get(index) == Some(&b';') {
        index += 1;
    }
    for end in (start + 1..=index).rev() {
        if let Some(&(first, second)) = html5ever::data::NAMED_ENTITIES.get(&source[start..end]) {
            if first != 0 {
                return Some((end, first, second));
            }
        }
    }
    None
}

fn first_non_whitespace(source: &str, mut index: usize, end: usize) -> usize {
    while index < end {
        if matches!(source.as_bytes()[index], b' ' | b'\t' | b'\n' | b'\r' | 12) {
            index += 1;
            continue;
        }
        if source.as_bytes()[index] == b'&' {
            if let Some((after, first, second)) = character_reference(source, index) {
                let whitespace = |value| matches!(value, 9 | 10 | 12 | 13 | 32);
                if after <= end && whitespace(first) && (second == 0 || whitespace(second)) {
                    index = after;
                    continue;
                }
            }
        }
        break;
    }
    index
}

#[derive(Clone, Debug)]
pub(crate) struct DiagnosticToken {
    pub kind: &'static str,
    pub name: Option<String>,
    pub span: (usize, usize),
    pub attributes: Vec<(String, usize, usize)>,
}

pub(crate) struct DiagnosticContext {
    source: RefCell<String>,
    source_len: Cell<usize>,
    source_base: Cell<usize>,
    keep_source: bool,
    track_positions: bool,
    positions: RefCell<Positions>,
    current: RefCell<DiagnosticToken>,
    token_error: RefCell<Option<Value>>,
    text_non_whitespace: Cell<Option<usize>>,
    input_error_cursor: Cell<usize>,
    is_document: Cell<bool>,
    codec: Cell<bool>,
}
impl DiagnosticContext {
    pub(crate) fn new(source: &str) -> Self {
        Self {
            source: RefCell::new(source.to_owned()),
            source_len: Cell::new(source.len()),
            source_base: Cell::new(0),
            keep_source: true,
            track_positions: true,
            positions: RefCell::new(Positions::new(source)),
            current: RefCell::new(DiagnosticToken {
                kind: "eof",
                name: None,
                span: (0, 0),
                attributes: Vec::new(),
            }),
            token_error: RefCell::new(None),
            text_non_whitespace: Cell::new(None),
            input_error_cursor: Cell::new(0),
            is_document: Cell::new(true),
            codec: Cell::new(false),
        }
    }
    #[cfg(test)]
    pub(crate) fn streaming(keep_source: bool) -> Self {
        Self::streaming_with_source_mode(keep_source, keep_source)
    }
    pub(crate) fn streaming_with_source_mode(keep_source: bool, track_positions: bool) -> Self {
        let mut context = Self::new("");
        context.keep_source = keep_source;
        context.track_positions = track_positions;
        context
    }
    pub(crate) fn append_source(&self, chunk: &str) {
        self.source_len.set(self.source_len.get() + chunk.len());
        if self.track_positions {
            self.positions.borrow_mut().append(chunk);
        }
        if self.keep_source || self.track_positions {
            const WINDOW: usize = 64 * 1024;
            let mut source = self.source.borrow_mut();
            if !self.keep_source && chunk.len() >= WINDOW {
                let mut start = chunk.len() - WINDOW;
                while !chunk.is_char_boundary(start) {
                    start += 1;
                }
                *source = chunk[start..].to_owned();
            } else {
                source.push_str(chunk);
                if !self.keep_source && source.len() > WINDOW {
                    let mut start = source.len() - WINDOW;
                    while !source.is_char_boundary(start) {
                        start += 1;
                    }
                    source.drain(..start);
                }
            }
            self.source_base.set(self.source_len.get() - source.len());
        }
    }
    pub(crate) fn source_len(&self) -> usize {
        self.source_len.get()
    }
    pub(crate) fn codec_enabled(&self) -> bool {
        self.codec.get()
    }
    fn input_error_offset(&self, error: Error) -> Option<usize> {
        if !matches!(
            error,
            Error::ControlCharacterInInputStream
                | Error::NoncharacterInInputStream
                | Error::SurrogateInInputStream
        ) {
            return None;
        }
        let source = self.source.borrow();
        let base = self.source_base.get();
        let mut start = self
            .input_error_cursor
            .get()
            .saturating_sub(base)
            .min(source.len());
        while !source.is_char_boundary(start) {
            start += 1;
        }
        let mut escaped = false;
        for (index, character) in source[start..].char_indices() {
            let value = character as u32;
            if self.codec_enabled() && character == crate::codec::ESCAPE && !escaped {
                escaped = true;
                continue;
            }
            let encoded_surrogate =
                self.codec_enabled() && !escaped && (0xe000..0xe800).contains(&value);
            escaped = false;
            let matches = match error {
                Error::ControlCharacterInInputStream => {
                    matches!(value,1..=8 | 11 | 14..=31 | 127..=159)
                }
                Error::NoncharacterInInputStream => {
                    matches!(value, 0xfdd0..=0xfdef) || value & 0xffff >= 0xfffe
                }
                _ => encoded_surrogate,
            };
            if matches {
                let point = base + start + index;
                self.input_error_cursor.set(point + character.len_utf8());
                return Some(point);
            }
        }
        None
    }
    pub(crate) fn source_between(&self, start: usize, end: usize) -> String {
        let base = self.source_base.get();
        if start < base || end < base {
            return String::new();
        }
        self.source
            .borrow()
            .get(start - base..end - base)
            .unwrap_or("")
            .to_owned()
    }
    pub(crate) fn location(&self, start: usize, end: usize) -> Value {
        let mut value = self.positions.borrow().record("", start, end);
        value.as_object_mut().unwrap().remove("code");
        value
    }
    pub(crate) fn current_span(&self) -> (usize, usize) {
        self.current.borrow().span
    }
    pub(crate) fn current_token(&self) -> DiagnosticToken {
        self.current.borrow().clone()
    }
    fn set(
        &self,
        kind: &'static str,
        name: Option<String>,
        span: Span<usize>,
        attributes: Vec<(String, usize, usize)>,
    ) {
        *self.current.borrow_mut() = DiagnosticToken {
            kind,
            name,
            span: (span.start, span.end),
            attributes,
        };
        self.token_error.borrow_mut().take();
    }
    pub(crate) fn error(&self, message: &str) -> Option<Value> {
        if let Some(error) = self.token_error.borrow().as_ref() {
            if error["code"] == message {
                return Some(error.clone());
            }
        }
        let token = self.current.borrow();
        let kind = match token.kind {
            "startTag" => Kind::Start(token.name.as_deref().unwrap_or("")),
            "endTag" => Kind::End(token.name.as_deref().unwrap_or("")),
            "doctype" => Kind::Doctype,
            "comment" => Kind::Comment,
            "eof" => Kind::Eof,
            _ => Kind::Text,
        };
        let code = if !self.is_document.get()
            && matches!(kind, Kind::End("template"))
            && message.starts_with("Unexpected token")
        {
            "end-tag-without-matching-open-element"
        } else {
            tree_code(message, kind)?
        };
        let source = self.source.borrow();
        let base = self.source_base.get();
        let mut start = token.span.0;
        if code == "missing-doctype" && matches!(kind, Kind::Text) {
            let end = token.span.1.saturating_sub(base).min(source.len());
            if start >= base {
                start = base + first_non_whitespace(&source, start - base, end);
            } else if let Some(first) = self.text_non_whitespace.get() {
                start = first;
            }
        }
        let end = if code == "missing-doctype" {
            start
        } else {
            token.span.1
        };
        Some(self.positions.borrow().record(code, start, end))
    }
}

fn text(value: &[u8]) -> String {
    String::from_utf8_lossy(value).into_owned()
}
fn apply_state<R: html5gum::Reader, H>(
    tokenizer: &mut Tokenizer<R, PositionedEmitter>,
    state: TokenSinkResult<H>,
) {
    match state {
        TokenSinkResult::Plaintext => tokenizer.set_state(State::PlainText),
        TokenSinkResult::RawData(RawKind::Rcdata) => tokenizer.set_state(State::RcData),
        TokenSinkResult::RawData(RawKind::Rawtext) => tokenizer.set_state(State::RawText),
        TokenSinkResult::RawData(RawKind::ScriptData | RawKind::ScriptDataEscaped(_)) => {
            tokenizer.set_state(State::ScriptData)
        }
        TokenSinkResult::Script(_) => tokenizer.set_state(State::Data),
        TokenSinkResult::Continue => {}
    }
}

/// Drive the actual user sink. Its parse_error callback can call context.error()
/// synchronously; callback mutations therefore affect this same tree builder.
pub(crate) fn parse_with_sink<S, F>(
    source: &str,
    is_document: bool,
    options: &Value,
    sink: S,
    context: Rc<DiagnosticContext>,
    on_step: F,
) -> S::Output
where
    S: TreeSink,
    F: FnMut(&S, &DiagnosticContext),
{
    use html5gum::Readable;
    match parse_reader_with_sink(
        source.to_reader(),
        is_document,
        options,
        sink,
        context,
        on_step,
    ) {
        Ok(output) => output,
        Err(error) => match error {},
    }
}

/// Reader variant supports a blocking streaming reader owned by a parsing
/// thread. html5gum does not support suspending/retrying a partial reader state.
pub(crate) fn parse_reader_with_sink<R, S, F>(
    reader: R,
    is_document: bool,
    options: &Value,
    sink: S,
    context: Rc<DiagnosticContext>,
    mut on_step: F,
) -> Result<S::Output, R::Error>
where
    R: html5gum::Reader,
    S: TreeSink,
    F: FnMut(&S, &DiagnosticContext),
{
    context.is_document.set(is_document);
    if options.get("__utf16Codec") == Some(&Value::Bool(true)) {
        context.codec.set(true);
        let mut positions = Positions::new("");
        positions.codec = true;
        positions.append(&context.source.borrow());
        *context.positions.borrow_mut() = positions;
    }
    let scripting_enabled = options.get("scriptingEnabled") != Some(&Value::Bool(false));
    let builder_options = TreeBuilderOpts {
        exact_errors: true,
        scripting_enabled,
        ..Default::default()
    };
    let context_name = options
        .get("__contextName")
        .and_then(Value::as_str)
        .unwrap_or("template");
    let tree = if is_document {
        TreeBuilder::new(sink, builder_options)
    } else {
        let element = html5ever::interface::create_element(
            &sink,
            QualName::new(
                None,
                Namespace::from(
                    options
                        .get("__contextNamespace")
                        .and_then(Value::as_str)
                        .unwrap_or(crate::HTML_NS),
                ),
                LocalName::from(context_name),
            ),
            Vec::new(),
        );
        TreeBuilder::new_for_fragment(sink, element, None, builder_options)
    };
    let foreign = Rc::new(Cell::new(false));
    let mut inner = DefaultEmitter::new_with_span();
    if !is_document {
        Emitter::set_last_start_tag(&mut inner, Some(context_name.as_bytes()));
    }
    let emitter = PositionedEmitter {
        inner,
        foreign: foreign.clone(),
        context: context.clone(),
        position: 0,
        text_kind: None,
        text_end: 0,
        boundaries: VecDeque::new(),
        deferred_text: None,
        queued: None,
        raw_queue: VecDeque::new(),
        eof: false,
    };
    let mut tokenizer = Tokenizer::new_with_emitter(reader, emitter);
    if !is_document {
        use html5ever::tokenizer::states::State as HtmlState;
        match tree.tokenizer_state_for_context_elem(scripting_enabled) {
            HtmlState::Plaintext => tokenizer.set_state(State::PlainText),
            HtmlState::RawData(kind) => {
                apply_state(&mut tokenizer, TokenSinkResult::<S::Handle>::RawData(kind))
            }
            _ => {}
        }
    }
    while let Some(token) = tokenizer.next() {
        let (inputs, span, kind, name, attributes) = match token? {
            Token::Error(error) => {
                let base = context.source_base.get();
                let point = if context.track_positions && error.span.start >= base {
                    base + token_error_offset(
                        &context.source.borrow(),
                        error.value,
                        Span {
                            start: error.span.start - base,
                            end: error.span.end.saturating_sub(base),
                        },
                    )
                } else if error.value.as_str().starts_with("eof-") {
                    error.span.start
                } else if error.value == Error::DuplicateAttribute {
                    error.span.end
                } else {
                    error.span.start.saturating_sub(1)
                };
                context.set("error", None, error.span, Vec::new());
                *context.token_error.borrow_mut() = Some(context.positions.borrow().record(
                    error.value.as_str(),
                    point,
                    point,
                ));
                tree.sink.parse_error(error.value.as_str().into());
                on_step(&tree.sink, &context);
                continue;
            }
            Token::StartTag(tag) => {
                let name = text(&tag.name);
                let mut entries: Vec<_> = tag.attributes.into_iter().collect();
                entries.sort_by_key(|(_, value)| value.span.start);
                let attributes = entries
                    .iter()
                    .map(|(name, value)| (text(name), value.span.start, value.span.end))
                    .collect();
                let attrs = entries
                    .into_iter()
                    .map(|(name, value)| Attribute {
                        name: QualName::new(
                            None,
                            Namespace::from(""),
                            LocalName::from(text(&name)),
                        ),
                        value: text(&value.value).into(),
                    })
                    .collect();
                (
                    vec![TreeToken::TagToken(Tag {
                        kind: TagKind::StartTag,
                        name: LocalName::from(name.clone()),
                        self_closing: tag.self_closing,
                        attrs,
                    })],
                    tag.span,
                    "startTag",
                    Some(name),
                    attributes,
                )
            }
            Token::EndTag(tag) => {
                let name = text(&tag.name);
                (
                    vec![TreeToken::TagToken(Tag {
                        kind: TagKind::EndTag,
                        name: LocalName::from(name.clone()),
                        self_closing: false,
                        attrs: Vec::new(),
                    })],
                    tag.span,
                    "endTag",
                    Some(name),
                    Vec::new(),
                )
            }
            Token::Doctype(doctype) => (
                vec![TreeToken::DoctypeToken(Doctype {
                    name: Some(text(&doctype.name).into()),
                    public_id: doctype
                        .public_identifier
                        .as_ref()
                        .map(|value| text(value).into()),
                    system_id: doctype
                        .system_identifier
                        .as_ref()
                        .map(|value| text(value).into()),
                    force_quirks: doctype.force_quirks,
                })],
                doctype.span,
                "doctype",
                None,
                Vec::new(),
            ),
            Token::Comment(comment) => (
                vec![TreeToken::CommentToken(text(&comment.value).into())],
                comment.span,
                "comment",
                None,
                Vec::new(),
            ),
            Token::String(value) => {
                let value_text = text(&value.value);
                let mut inputs = Vec::new();
                for (index, part) in value_text.split('\0').enumerate() {
                    if index > 0 {
                        inputs.push(TreeToken::NullCharacterToken);
                    }
                    if !part.is_empty() {
                        inputs.push(TreeToken::CharacterTokens(part.to_owned().into()));
                    }
                }
                (inputs, value.span, "text", None, Vec::new())
            }
        };
        context.set(kind, name, span, attributes);
        for input in inputs {
            let line = context.positions.borrow().point(span.start).line as u64;
            let state = tree.process_token(input, line);
            on_step(&tree.sink, &context);
            foreign.set(tree.adjusted_current_node_present_but_not_in_html_namespace());
            apply_state(&mut tokenizer, state);
        }
    }
    let end = context.source_len();
    context.set("eof", None, Span { start: end, end }, Vec::new());
    let _ = tree.process_token(
        TreeToken::EOFToken,
        context.positions.borrow().point(end).line as u64,
    );
    on_step(&tree.sink, &context);
    tree.end();
    Ok(tree.sink.finish())
}

pub(crate) fn collect(source: &str, is_document: bool, options: &Value) -> Vec<Value> {
    let context = Rc::new(DiagnosticContext::new(source));
    let sink = CompatibleSink::with_errors(if is_document {
        Html::new_document()
    } else {
        Html::new_fragment()
    });
    let mut errors = Vec::new();
    parse_with_sink(
        source,
        is_document,
        options,
        sink,
        context,
        |sink, context| {
            for message in sink.take_errors() {
                if let Some(error) = context.error(&message) {
                    errors.push(error);
                }
            }
        },
    );
    errors
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_offsets_and_crlf_match_parse5() {
        let errors = collect("<!doctype html>😀\r\n<div a=>", true, &json!({}));
        assert_eq!(
            errors,
            vec![
                json!({"code":"missing-attribute-value","startLine":2,"endLine":2,"startCol":8,"endCol":8,"startOffset":26,"endOffset":26})
            ]
        );
    }

    #[test]
    fn token_errors_precede_missing_doctype_and_keep_real_positions() {
        let errors = collect("\n<p a=1 a=2>", true, &json!({}));
        assert_eq!(
            errors,
            vec![
                json!({"code":"duplicate-attribute","startLine":2,"endLine":2,"startCol":9,"endCol":9,"startOffset":9,"endOffset":9}),
                json!({"code":"missing-doctype","startLine":2,"endLine":2,"startCol":1,"endCol":1,"startOffset":1,"endOffset":1}),
            ]
        );
    }

    #[test]
    fn document_and_foreign_tree_context_control_tokenization() {
        assert!(collect(
            "<!doctype html><svg><![CDATA[x]]><path/></svg>",
            true,
            &json!({})
        )
        .is_empty());
        assert!(collect("<p>fragment</p>", false, &json!({})).is_empty());
        let errors = collect("<!doctype html><div/>", true, &json!({}));
        assert_eq!(
            errors,
            vec![
                json!({"code":"non-void-html-element-start-tag-with-trailing-solidus","startLine":1,"endLine":1,"startCol":16,"endCol":22,"startOffset":15,"endOffset":21})
            ]
        );
    }

    #[test]
    fn numeric_entity_and_eof_errors_are_not_generic_recovery_warnings() {
        let errors = collect("<p>&#0;&#x110000;&amp x</p>", true, &json!({}));
        let codes: Vec<_> = errors
            .iter()
            .map(|error| error["code"].as_str().unwrap())
            .collect();
        assert_eq!(
            codes,
            vec![
                "missing-doctype",
                "null-character-reference",
                "character-reference-outside-unicode-range",
                "missing-semicolon-after-character-reference"
            ]
        );
        assert_eq!(errors[1]["startOffset"], 7);
        assert_eq!(errors[2]["startOffset"], 17);
        assert_eq!(errors[3]["startOffset"], 21);
        assert_eq!(collect("<!--x", true, &json!({}))[0]["startOffset"], 5);
    }

    #[test]
    fn incremental_positions_preserve_unicode_and_split_crlf() {
        let source = "ASCII😀\r\n<div café=>終";
        let expected = DiagnosticContext::new(source);
        let incremental = DiagnosticContext::streaming(true);
        for chunk in ["ASCII", "😀\r", "\n<div caf", "é=>", "終"] {
            incremental.append_source(chunk);
        }
        assert_eq!(incremental.source_len(), source.len());
        assert_eq!(incremental.source_between(5, 9), "😀");
        for start in 0..=source.len() {
            assert_eq!(
                incremental.location(start, source.len()),
                expected.location(start, source.len())
            );
        }
        assert_eq!(incremental.location(11, 11)["startLine"], 2);
        assert_eq!(incremental.location(11, 11)["startCol"], 1);
        assert_eq!(incremental.location(11, 11)["startOffset"], 9);
    }

    #[test]
    fn ascii_streams_do_not_allocate_positions_or_retain_unrequested_source() {
        let source = "x".repeat(1024 * 1024);
        let retained = DiagnosticContext::streaming(true);
        retained.append_source(&source);
        assert_eq!(retained.positions.borrow().checkpoints.len(), 1);
        assert_eq!(
            retained.location(source.len(), source.len())["startOffset"],
            source.len()
        );
        let untracked = DiagnosticContext::streaming(false);
        untracked.append_source(&source);
        assert_eq!(untracked.source_len(), source.len());
        assert!(untracked.source.borrow().is_empty());
        assert_eq!(untracked.positions.borrow().checkpoints.len(), 1);
    }

    #[test]
    fn diagnostics_only_streams_keep_a_bounded_utf8_window_and_global_positions() {
        let context = DiagnosticContext::streaming_with_source_mode(false, true);
        let chunk = "line café😀\r\n".repeat(8192);
        context.append_source(&chunk);
        context.append_source("<p a=>");
        assert!(context.source.borrow().len() <= 64 * 1024);
        assert_eq!(context.source_len(), chunk.len() + 6);
        assert_eq!(
            context.source_between(chunk.len(), context.source_len()),
            "<p a=>"
        );
        assert_eq!(
            context.location(chunk.len(), chunk.len())["startLine"],
            8193
        );
        assert_eq!(context.location(chunk.len(), chunk.len())["startCol"], 1);
        assert_eq!(
            context.location(chunk.len(), chunk.len())["startOffset"],
            chunk.encode_utf16().count()
        );
    }

    #[test]
    fn leading_whitespace_error_location_survives_source_window_eviction() {
        struct Input<'a> {
            source: &'a str,
            cursor: usize,
            context: Rc<DiagnosticContext>,
        }
        impl html5gum::Reader for Input<'_> {
            type Error = std::convert::Infallible;
            fn read_byte(&mut self) -> Result<Option<u8>, Self::Error> {
                if self.cursor == self.source.len() {
                    return Ok(None);
                }
                let byte = self.source.as_bytes()[self.cursor];
                self.context
                    .append_source(&self.source[self.cursor..self.cursor + 1]);
                self.cursor += 1;
                Ok(Some(byte))
            }
            fn try_read_string(
                &mut self,
                value: &[u8],
                case_sensitive: bool,
            ) -> Result<bool, Self::Error> {
                let remaining = &self.source.as_bytes()[self.cursor..];
                if remaining.len() < value.len()
                    || !remaining[..value.len()]
                        .iter()
                        .zip(value)
                        .all(|(left, right)| {
                            if case_sensitive {
                                left == right
                            } else {
                                left.eq_ignore_ascii_case(right)
                            }
                        })
                {
                    return Ok(false);
                }
                for _ in value {
                    self.read_byte()?;
                }
                Ok(true)
            }
        }
        let source = format!("{}&#32;\r\nX", " ".repeat(70_000));
        let context = Rc::new(DiagnosticContext::streaming_with_source_mode(false, true));
        let reader = Input {
            source: &source,
            cursor: 0,
            context: context.clone(),
        };
        let mut errors = Vec::new();
        parse_reader_with_sink(
            reader,
            true,
            &json!({}),
            CompatibleSink::with_errors(Html::new_document()),
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
        assert_eq!(
            errors,
            vec![
                json!({"code":"missing-doctype","startLine":2,"startCol":1,"startOffset":70_007,"endLine":2,"endCol":1,"endOffset":70_007})
            ]
        );
    }

    #[test]
    fn encoded_surrogates_report_live_errors_without_private_use_aliases() {
        let mut units: Vec<u16> = "<!doctype html>😀\r\n<p a=\"".encode_utf16().collect();
        units.extend([0xd800, 0xe000, 0xdfff]);
        units.extend("\">".encode_utf16());
        units.push(0xd800);
        units.extend("</p>".encode_utf16());
        let source = crate::codec::from_units(&units);
        let errors = collect(&source, true, &json!({"__utf16Codec":true}));
        assert_eq!(
            errors,
            vec![
                json!({"code":"surrogate-in-input-stream","startLine":2,"endLine":2,"startCol":7,"endCol":7,"startOffset":25,"endOffset":25}),
                json!({"code":"surrogate-in-input-stream","startLine":2,"endLine":2,"startCol":9,"endCol":9,"startOffset":27,"endOffset":27}),
                json!({"code":"surrogate-in-input-stream","startLine":2,"endLine":2,"startCol":12,"endCol":12,"startOffset":30,"endOffset":30})
            ]
        );
    }

    #[test]
    fn numeric_private_use_entities_stay_literal_in_every_native_parser() {
        let source = "<!doctype html><p a=\"&#xe000;&#xe800;\">&#xe000;&#xe800;&#xd800;</p>";
        for options in [
            json!({"__utf16Codec":true}),
            json!({"__utf16Codec":true,"xmlMode":true}),
            json!({"__utf16Codec":true,"_useHtmlParser2":true,"xmlMode":false}),
        ] {
            let document =
                crate::NativeDocument::new(source.to_owned(), true, Some(options.to_string()));
            let text: Value = serde_json::from_str(
                &document
                    .op("text".into(), json!({"ids":[0]}).to_string())
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(
                crate::codec::to_units(text.as_str().unwrap()),
                vec![0xe000, 0xe800, 0xfffd]
            );
            let ids = document.select("p".into(), None).unwrap();
            let attribute: Value = serde_json::from_str(
                &document
                    .op("attr".into(), json!({"ids":ids,"name":"a"}).to_string())
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(
                crate::codec::to_units(attribute.as_str().unwrap()),
                vec![0xe000, 0xe800]
            );
        }
        let errors = collect(source, true, &json!({"__utf16Codec":true}));
        assert_eq!(
            errors
                .iter()
                .map(|error| error["code"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["surrogate-character-reference"]
        );
    }
}
