//! Build htmlparser2-compatible trees from tokenizer events. Events come from
//! the native tokenizer port or from an explicitly supplied JavaScript
//! Tokenizer, whose recorded events directly determine the DOM.
use crate::arena::{
    append_parsed, append_parsed_new, append_parsed_text, html_parser_void, implied_close,
    DomArena, DomNode,
};
use crate::markup_tokenizer::Token;
use serde_json::{json, Value};

struct Pending {
    name: String,
    start: usize,
}
struct Builder<'a> {
    arena: DomArena,
    source: &'a Source<'a>,
    parents: Vec<u32>,
    foreign: Vec<bool>,
    pending: Option<Pending>,
    /// The pending tag's attributes in source order, collected so its map is
    /// allocated once at its final size.
    attributes: Vec<(String, String)>,
    attribute_name: String,
    attribute_value: String,
    start: usize,
    end: usize,
    xml: bool,
    lower_tags: bool,
    lower_attrs: bool,
    with_end_indices: bool,
    recognize_self_closing: Option<bool>,
}
impl<'a> Builder<'a> {
    fn new(source: &'a Source<'a>, options: Value) -> Self {
        let xml = crate::arena::xml_mode(&options);
        let lower_tags = options
            .get("lowerCaseTags")
            .and_then(Value::as_bool)
            .unwrap_or(!xml);
        let lower_attrs = options
            .get("lowerCaseAttributeNames")
            .and_then(Value::as_bool)
            .unwrap_or(!xml);
        let with_end_indices = options.get("withEndIndices") == Some(&Value::Bool(true));
        let recognize_self_closing = options.get("recognizeSelfClosing").and_then(Value::as_bool);
        let mut arena = DomArena::from_records(vec![DomNode::new("root")], options);
        // Growing the arena one doubling at a time copies every node record
        // again. Every node but text starts with `<`, and text lies between them.
        let markup_starts = source
            .units
            .iter()
            .filter(|unit| **unit == u16::from(b'<'))
            .count();
        arena.nodes.reserve(markup_starts + 1);
        Self {
            arena,
            source,
            parents: vec![0],
            foreign: vec![xml],
            pending: None,
            attributes: Vec::new(),
            attribute_name: String::new(),
            attribute_value: String::new(),
            start: 0,
            end: 0,
            xml,
            lower_tags,
            lower_attrs,
            with_end_indices,
            recognize_self_closing,
        }
    }
    fn slice(&self, start: usize, end: usize) -> String {
        self.source.slice(start, end)
    }
    fn name(&self, start: usize, end: usize) -> String {
        let name = self.slice(start, end);
        if self.lower_tags {
            lowercase(name)
        } else {
            name
        }
    }
    fn close(&mut self) {
        if let Some(id) = (self.parents.len() > 1).then(|| self.parents.pop().unwrap()) {
            if self.with_end_indices {
                self.arena.nodes[id as usize]
                    .extras
                    .insert("endIndex".into(), json!(self.end));
            }
        }
    }
    fn open(&mut self, name: String) {
        if !self.xml {
            while self
                .parents
                .last()
                .and_then(|id| self.arena.node(*id))
                .and_then(|node| node.name.as_deref())
                .is_some_and(|open| implied_close(&name, open))
            {
                self.close();
            }
        }
        // htmlparser2 tracks foreign content only in HTML mode.
        if !self.xml && !html_parser_void(&name) {
            if matches!(name.as_str(), "svg" | "math") {
                self.foreign.push(true);
            } else if matches!(
                name.as_str(),
                "mi" | "mo"
                    | "mn"
                    | "ms"
                    | "mtext"
                    | "annotation-xml"
                    | "foreignobject"
                    | "desc"
                    | "title"
            ) {
                self.foreign.push(false);
            }
        }
        self.attributes.clear();
        self.pending = Some(Pending {
            name,
            start: self.start,
        });
    }
    fn end_open(&mut self, self_closing: bool) {
        if let Some(pending) = self.pending.take() {
            let is_void = !self.xml && html_parser_void(&pending.name);
            let kind = match pending.name.as_str() {
                "script" if !self.xml => "script",
                "style" if !self.xml => "style",
                _ => "tag",
            };
            let lowercase_name = (pending.name.bytes().any(|byte| byte.is_ascii_uppercase()))
                .then(|| pending.name.to_ascii_lowercase());
            let id = append_parsed_new(
                &mut self.arena,
                *self.parents.last().unwrap(),
                kind,
                pending.start,
                self.end,
            );
            let node = &mut self.arena.nodes[id as usize];
            node.name = Some(pending.name);
            node.attribs = deduplicated_attributes(self.attributes.drain(..));
            let name = lowercase_name
                .as_deref()
                .or(self.arena.nodes[id as usize].name.as_deref())
                .unwrap_or("");
            let index = self.arena.name_index.get_or_insert_with(Default::default);
            match index.get_mut(name) {
                Some(ids) => ids.push(id),
                None => {
                    index.insert(name.to_owned(), vec![id]);
                }
            }
            if !is_void && !self_closing {
                self.parents.push(id);
            }
        }
    }
    fn text(&mut self, data: String, end: usize) {
        self.end = end.saturating_sub(1);
        append_parsed_text(
            &mut self.arena,
            *self.parents.last().unwrap(),
            data,
            self.start,
            self.end,
        );
        self.start = end;
    }
    fn instruction(&mut self, start: usize, end: usize, prefix: char) {
        let value = self.slice(start, end);
        let boundary = value
            .find(|ch: char| ch.is_whitespace() || ch == '/')
            .unwrap_or(value.len());
        let name = if self.lower_tags {
            value[..boundary].to_lowercase()
        } else {
            value[..boundary].to_owned()
        };
        let mut node = DomNode::new("directive");
        node.name = Some(format!("{prefix}{name}"));
        node.data = Some(format!("{prefix}{value}"));
        append_parsed(
            &mut self.arena,
            *self.parents.last().unwrap(),
            node,
            self.start,
            end,
        );
        self.end = end;
        self.start = end + 1;
    }
}

/// Attributes a tag listed in source order; a repeated attribute keeps its
/// first value, as htmlparser2 does. Few attributes are compared directly,
/// many through a set of the names seen.
fn deduplicated_attributes(
    attributes: std::vec::Drain<'_, (String, String)>,
) -> crate::arena::Attributes {
    const DIRECT_LIMIT: usize = 16;
    let count = attributes.len();
    let mut result = crate::arena::Attributes::with_capacity(count);
    if count <= DIRECT_LIMIT {
        for (name, value) in attributes {
            result.push_unique(name, Value::String(value));
        }
        return result;
    }
    let mut seen = std::collections::HashSet::with_capacity(count);
    for (name, value) in attributes {
        if seen.insert(name.clone()) {
            result.push(name, Value::String(value));
        }
    }
    result
}

/// Sources from JavaScript, or that contain codec frames, use the lossless
/// UTF-16 representation; others are plain Unicode.
fn is_codec_encoded(options: &Value) -> bool {
    options.get("__utf16Codec") == Some(&Value::Bool(true))
        || options.get("__losslessUnicode") == Some(&Value::Bool(true))
}

fn lowercase(mut name: String) -> String {
    if name.is_ascii() {
        name.make_ascii_lowercase();
        name
    } else {
        name.to_lowercase()
    }
}

/// The source as UTF-16 units, with each unit's byte offset in the original
/// string so spans can be copied from it instead of re-encoded.
struct Source<'a> {
    text: &'a str,
    units: Vec<u16>,
    /// Byte offset per unit index, plus one for the end; `u32::MAX` marks an
    /// index inside a character. `None` for ASCII, where offsets are indices.
    offsets: Option<Vec<u32>>,
    codec: bool,
}

struct IndexedUnits {
    units: Vec<u16>,
    offsets: Vec<u32>,
}

impl crate::codec::UnitSink for IndexedUnits {
    fn ascii(&mut self, start: usize, run: &[u8]) {
        self.units.extend(run.iter().map(|value| u16::from(*value)));
        self.offsets
            .extend((start..start + run.len()).map(|offset| offset as u32));
    }
    fn unit(&mut self, offset: Option<usize>, unit: u16) {
        self.units.push(unit);
        self.offsets
            .push(offset.map_or(u32::MAX, |offset| offset as u32));
    }
}

impl<'a> Source<'a> {
    fn new(text: &'a str, options: &Value) -> Self {
        let codec = is_codec_encoded(options);
        if text.is_ascii() {
            return Self {
                text,
                units: text.bytes().map(u16::from).collect(),
                offsets: None,
                codec,
            };
        }
        let mut indexed = IndexedUnits {
            units: Vec::with_capacity(text.len()),
            offsets: Vec::with_capacity(text.len() + 1),
        };
        let framed = codec && crate::codec::has_encoding(text);
        crate::codec::visit_units(text, framed, &mut indexed);
        indexed.offsets.push(text.len() as u32);
        Self {
            text,
            units: indexed.units,
            offsets: Some(indexed.offsets),
            codec,
        }
    }
    fn slice(&self, start: usize, end: usize) -> String {
        let start = start.min(self.units.len());
        let end = end.clamp(start, self.units.len());
        let Some(offsets) = self.offsets.as_ref() else {
            return self.text[start..end].to_owned();
        };
        match (offsets[start], offsets[end]) {
            (from, to) if from != u32::MAX && to != u32::MAX => {
                self.text[from as usize..to as usize].to_owned()
            }
            _ if self.codec => crate::codec::from_units(&self.units[start..end]),
            _ => String::from_utf16_lossy(&self.units[start..end]),
        }
    }
}

/// Parses markup with the native port of htmlparser2's Tokenizer.
pub(crate) fn parse_markup(source: &str, options: Value) -> DomArena {
    let source = Source::new(source, &options);
    let decode = options.get("decodeEntities") != Some(&Value::Bool(false));
    let mut builder = Builder::new(&source, options);
    let xml = builder.xml;
    crate::markup_tokenizer::tokenize(&source.units, xml, decode, |token| builder.handle(token));
    builder.arena
}

/// Replays events recorded from a JavaScript htmlparser2 Tokenizer.
pub(crate) fn parse(source: &str, events: &Value, options: Value) -> DomArena {
    let source = Source::new(source, &options);
    let units = source.units.len() as i64;
    let mut builder = Builder::new(&source, options);
    for event in events.as_array().into_iter().flatten() {
        let Some(tuple) = event.as_array() else {
            continue;
        };
        let Some(event) = tuple.first().and_then(Value::as_str) else {
            continue;
        };
        // htmlparser2 reports an unset section start as -1, which its
        // `slice` resolves from the end of the input.
        let arg = |index: usize| {
            let value = tuple.get(index + 1).and_then(Value::as_i64).unwrap_or(0);
            if value < 0 {
                (units + value).max(0) as usize
            } else {
                value as usize
            }
        };
        let (a, b, c) = (arg(0), arg(1), arg(2));
        match event {
            "ontext" => builder.on_text(a, b, false),
            "ontextentity" => {
                let text = builder.code_point(a);
                builder.text(text, b);
            }
            "onopentagname" => builder.on_open_tag_name(a, b),
            "onopentagend" => builder.on_open_tag_end(a),
            "onselfclosingtag" => builder.on_self_closing_tag(a),
            "onattribname" => builder.on_attribute_name(a, b),
            "onattribdata" => builder.on_attribute_data(a, b, false),
            "onattribentity" => {
                let text = builder.code_point(a);
                builder.attribute_value.push_str(&text);
            }
            "onattribend" => builder.on_attribute_end(b),
            "onclosetag" => builder.on_close_tag(a, b),
            "ondeclaration" => builder.instruction(a, b, '!'),
            "onprocessinginstruction" => builder.instruction(a, b, '?'),
            "oncomment" => builder.on_comment(a, b, c),
            "oncdata" => builder.on_cdata(a, b, c),
            "onend" => builder.on_end(),
            _ => {}
        }
    }
    builder.arena
}

impl Builder<'_> {
    fn handle(&mut self, token: Token) {
        match token {
            Token::Text { start, end, decode } => self.on_text(start, end, decode),
            Token::OpenTagName { start, end } => self.on_open_tag_name(start, end),
            Token::OpenTagEnd { end } => self.on_open_tag_end(end),
            Token::SelfClosingTag { end } => self.on_self_closing_tag(end),
            Token::AttributeName { start, end } => self.on_attribute_name(start, end),
            Token::AttributeData { start, end, decode } => {
                self.on_attribute_data(start, end, decode)
            }
            Token::AttributeEnd { end } => self.on_attribute_end(end),
            Token::CloseTag { start, end } => self.on_close_tag(start, end),
            Token::Comment {
                start,
                end,
                end_offset,
            } => self.on_comment(start, end, end_offset),
            Token::Cdata {
                start,
                end,
                end_offset,
            } => self.on_cdata(start, end, end_offset),
            Token::Declaration { start, end } => self.instruction(start, end, '!'),
            Token::ProcessingInstruction { start, end } => self.instruction(start, end, '?'),
            Token::End => self.on_end(),
        }
    }
    fn code_point(&self, code_point: usize) -> String {
        if code_point <= 0xffff {
            crate::codec::from_units(&[code_point as u16])
        } else {
            crate::codec::encode_scalar(char::from_u32(code_point as u32).unwrap_or('\u{fffd}'))
        }
    }
    fn on_text(&mut self, start: usize, end: usize, decode: bool) {
        let raw = self.slice(start, end);
        let text = if decode && raw.contains('&') {
            crate::arena::decode_entities_mode(&raw, self.xml, false, self.source.codec)
        } else {
            raw
        };
        self.text(text, end);
    }
    fn on_open_tag_name(&mut self, start: usize, end: usize) {
        self.end = end;
        let name = self.name(start, end);
        self.open(name);
    }
    fn on_open_tag_end(&mut self, end: usize) {
        self.end = end;
        self.end_open(false);
        self.start = end + 1;
    }
    fn on_self_closing_tag(&mut self, end: usize) {
        self.end = end;
        let self_closing = self.recognize_self_closing.unwrap_or(self.xml)
            || *self.foreign.last().unwrap_or(&self.xml);
        self.end_open(self_closing);
        self.start = end + 1;
    }
    fn on_attribute_name(&mut self, start: usize, end: usize) {
        self.start = start;
        let name = self.slice(start, end);
        self.attribute_name = if self.lower_attrs {
            lowercase(name)
        } else {
            name
        };
    }
    fn on_attribute_data(&mut self, start: usize, end: usize, decode: bool) {
        let raw = self.slice(start, end);
        let data = if decode && raw.contains('&') {
            crate::arena::decode_entities_mode(&raw, self.xml, true, self.source.codec)
        } else {
            raw
        };
        if self.attribute_value.is_empty() {
            self.attribute_value = data;
        } else {
            self.attribute_value.push_str(&data);
        }
    }
    fn on_attribute_end(&mut self, end: usize) {
        self.end = end;
        let value = std::mem::take(&mut self.attribute_value);
        if self.pending.is_some() {
            self.attributes
                .push((std::mem::take(&mut self.attribute_name), value));
        }
    }
    fn on_close_tag(&mut self, start: usize, end: usize) {
        self.end = end;
        let name = self.name(start, end);
        if !self.xml
            && matches!(
                name.as_str(),
                "svg"
                    | "math"
                    | "mi"
                    | "mo"
                    | "mn"
                    | "ms"
                    | "mtext"
                    | "annotation-xml"
                    | "foreignobject"
                    | "desc"
                    | "title"
            )
        {
            self.foreign.pop();
        }
        if !(!self.xml && html_parser_void(&name)) {
            if let Some(position) = self.parents.iter().rposition(|id| {
                self.arena.node(*id).and_then(|node| node.name.as_deref()) == Some(name.as_str())
            }) {
                while self.parents.len() > position {
                    self.close();
                }
            } else if !self.xml && name == "p" {
                self.open(name);
                self.end_open(true);
            }
        } else if !self.xml && name == "br" {
            self.open(name);
            self.end_open(true);
        }
        self.start = end + 1;
    }
    fn on_comment(&mut self, start: usize, end: usize, end_offset: usize) {
        let mut node = DomNode::new("comment");
        node.data = Some(self.slice(start, end.saturating_sub(end_offset)));
        append_parsed(
            &mut self.arena,
            *self.parents.last().unwrap(),
            node,
            self.start,
            end,
        );
        self.end = end;
        self.start = end + 1;
    }
    fn on_cdata(&mut self, start: usize, end: usize, end_offset: usize) {
        let data = self.slice(start, end.saturating_sub(end_offset));
        if self.xml || self.arena.options.get("recognizeCDATA") == Some(&Value::Bool(true)) {
            let id = append_parsed(
                &mut self.arena,
                *self.parents.last().unwrap(),
                DomNode::new("cdata"),
                self.start,
                end,
            );
            let mut text = DomNode::new("text");
            text.data = Some(data);
            text.parent = Some(id);
            text.extras.insert("startIndex".into(), Value::Null);
            text.extras.insert(
                "endIndex".into(),
                if self.arena.options.get("withEndIndices") == Some(&Value::Bool(true)) {
                    json!(end)
                } else {
                    Value::Null
                },
            );
            let child = self.arena.push(text);
            self.arena.nodes[id as usize].children.push(child);
        } else {
            let mut node = DomNode::new("comment");
            node.data = Some(format!("[CDATA[{data}]]"));
            append_parsed(
                &mut self.arena,
                *self.parents.last().unwrap(),
                node,
                self.start,
                end,
            );
        }
        self.end = end;
        self.start = end + 1;
    }
    fn on_end(&mut self) {
        self.end = self.start;
        while self.parents.len() > 1 {
            self.close();
        }
    }
}
