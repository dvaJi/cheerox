//! Attach source spans to actual HTML5 sink operations. Scanner metadata is
//! retained only as a fallback for deferred table text and parser-only closures.
use crate::diagnostics::DiagnosticContext;
use serde_json::{Map, Value};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::hash::Hash;
use std::rc::Rc;

pub(crate) struct Locations<K> {
    context: Rc<DiagnosticContext>,
    records: RefCell<HashMap<K, Value>>,
    names: RefCell<HashMap<K, String>>,
    closed: RefCell<HashSet<K>>,
}
impl<K: Copy + Eq + Hash> Locations<K> {
    pub(crate) fn new(context: Rc<DiagnosticContext>) -> Self {
        Self {
            context,
            records: RefCell::new(HashMap::new()),
            names: RefCell::new(HashMap::new()),
            closed: RefCell::new(HashSet::new()),
        }
    }
    pub(crate) fn created(&self, id: K, name: &str) {
        self.names.borrow_mut().insert(id, name.to_owned());
        self.closed.borrow_mut().remove(&id);
        let token = self.context.current_token();
        let value = if token.kind == "startTag"
            && token
                .name
                .as_deref()
                .is_some_and(|token| token.eq_ignore_ascii_case(name))
        {
            let mut range = self.context.location(token.span.0, token.span.1);
            if !token.attributes.is_empty() {
                let attrs: Map<String, Value> = token
                    .attributes
                    .into_iter()
                    .map(|(name, start, _end)| {
                        let raw = self.context.source_between(start, token.span.1);
                        let bytes = raw.as_bytes();
                        let mut end = 0;
                        while end < bytes.len()
                            && !bytes[end].is_ascii_whitespace()
                            && !matches!(bytes[end], b'=' | b'>' | b'/')
                        {
                            end += 1;
                        }
                        let name_end = end;
                        while end < bytes.len() && bytes[end].is_ascii_whitespace() {
                            end += 1;
                        }
                        if bytes.get(end) == Some(&b'=') {
                            end += 1;
                            while end < bytes.len() && bytes[end].is_ascii_whitespace() {
                                end += 1;
                            }
                            if let Some(q @ (b'\'' | b'"')) = bytes.get(end).copied() {
                                end += 1;
                                while end < bytes.len() && bytes[end] != q {
                                    end += 1;
                                }
                                end += (end < bytes.len()) as usize;
                            } else {
                                while end < bytes.len()
                                    && !bytes[end].is_ascii_whitespace()
                                    && bytes[end] != b'>'
                                {
                                    end += 1;
                                }
                            }
                        } else {
                            end = name_end;
                        }
                        (name, self.context.location(start, start + end))
                    })
                    .collect();
                range["attrs"] = Value::Object(attrs);
            }
            range["startTag"] = range.clone();
            if crate::void_name(name) {
                self.closed.borrow_mut().insert(id);
            }
            range
        } else if matches!(
            name,
            "a" | "b"
                | "big"
                | "code"
                | "em"
                | "font"
                | "i"
                | "nobr"
                | "s"
                | "small"
                | "strike"
                | "strong"
                | "tt"
                | "u"
        ) {
            let names = self.names.borrow();
            let records = self.records.borrow();
            records
                .iter()
                .filter(|(other, value)| {
                    names.get(other).is_some_and(|other| other == name)
                        && value.get("startTag").is_some()
                })
                .max_by_key(|(_, value)| value["startOffset"].as_u64().unwrap_or(0))
                .map(|(_, value)| {
                    let mut value = value.clone();
                    if let Some(object) = value.as_object_mut() {
                        object.remove("endTag");
                    }
                    let tag = value["startTag"].clone();
                    for field in ["endLine", "endCol", "endOffset"] {
                        value[field] = tag[field].clone();
                    }
                    value
                })
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        self.records.borrow_mut().insert(id, value);
    }
    pub(crate) fn closed(&self, id: K) {
        let token = self.context.current_token();
        if !matches!(token.kind, "startTag" | "endTag" | "eof") {
            return;
        }
        if self.closed.borrow().contains(&id) {
            return;
        }
        let names = self.names.borrow();
        let Some(name) = names.get(&id) else {
            return;
        };
        let mut records = self.records.borrow_mut();
        let Some(Value::Object(record)) = records.get_mut(&id) else {
            return;
        };
        if record.contains_key("endTag") {
            return;
        }
        self.closed.borrow_mut().insert(id);
        let explicit = token.kind == "endTag"
            && token
                .name
                .as_deref()
                .is_some_and(|token| token.eq_ignore_ascii_case(name));
        let end = if explicit { token.span.1 } else { token.span.0 };
        let point = self.context.location(end, end);
        for field in ["endLine", "endCol", "endOffset"] {
            record.insert(field.into(), point[field].clone());
        }
        if explicit {
            record.insert(
                "endTag".into(),
                self.context.location(token.span.0, token.span.1),
            );
        }
    }
    pub(crate) fn closed_as(&self, id: K, name: &str) {
        let previous = self.names.borrow_mut().insert(id, name.to_owned());
        self.closed(id);
        if let Some(previous) = previous {
            self.names.borrow_mut().insert(id, previous);
        }
    }
    pub(crate) fn token(&self, id: K, kind: &str) {
        let token = self.context.current_token();
        if token.kind == kind {
            self.records
                .borrow_mut()
                .insert(id, self.context.location(token.span.0, token.span.1));
        }
    }
    pub(crate) fn text(&self, id: K, data: &str) {
        let token = self.context.current_token();
        if token.kind != "text" {
            return;
        }
        let (mut start, end) = self.context.current_span();
        let raw = self.context.source_between(start, end);
        let normalized = raw
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .replace('\0', "\u{fffd}");
        let decoded = crate::arena::decode_entities_mode(
            &normalized,
            false,
            false,
            self.context.codec_enabled(),
        );
        if normalized != data && decoded != data {
            if normalized.starts_with('\n')
                && (&normalized[1..] == data
                    || crate::arena::decode_entities_mode(
                        &normalized[1..],
                        false,
                        false,
                        self.context.codec_enabled(),
                    ) == data)
            {
                start += if raw.starts_with("\r\n") { 2 } else { 1 };
            } else {
                return;
            }
        }
        let range = self.context.location(start, end);
        let mut records = self.records.borrow_mut();
        if let Some(Value::Object(record)) = records.get_mut(&id) {
            for field in ["endLine", "endCol", "endOffset"] {
                record.insert(field.into(), range[field].clone());
            }
        } else {
            records.insert(id, range);
        }
    }
    pub(crate) fn get(&self, id: K) -> Option<Value> {
        self.records.borrow().get(&id).cloned()
    }
    pub(crate) fn take(&self) -> HashMap<K, Value> {
        let ids: Vec<_> = self.names.borrow().keys().copied().collect();
        for id in ids {
            self.closed(id);
        }
        std::mem::take(&mut *self.records.borrow_mut())
    }
}
