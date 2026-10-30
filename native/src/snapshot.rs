//! A compact copy of every node record that JavaScript decodes lazily. One call
//! replaces a native round trip per node when a document is read node by node.
//!
//! Each node occupies `STRIDE` entries of `nodes`:
//! 0 type, 1 parent + 1, 2 previous sibling + 1, 3 next sibling + 1,
//! 4 first entry in `children`, 5 child count, 6 name + 1, 7 data + 1,
//! 8 first pair in `attributes`, 9 attribute count, 10 flags, 11 start index,
//! 12 end index, 13 namespace, 14 remaining fields as JSON + 1.
//! String references index pairs of UTF-16 offsets into `text`.
//!
//! JavaScript receives one `Uint32Array`: the lengths of `nodes`, `children`,
//! `attributes` and `strings`, whether any string holds codec escapes, then
//! the four lists. String offsets count UTF-16 units of the encoded text, so
//! JavaScript decodes only the strings it reads. Its memory belongs to V8,
//! which frees it as soon as the snapshot is collected; an external buffer
//! would add finalizer bookkeeping and wait for a later event-loop turn.
use html5ever::{LocalName, Namespace};
use napi::{check_status, sys, Env, JsObject, JsTypedArray, NapiValue, Result};
use scraper::Node;
use serde_json::{Map, Value};

use crate::arena::DomNode;
use crate::id_hash::IdMap;
use crate::NativeDocument;

pub(crate) const STRIDE: usize = 15;
/// Text or attribute values longer than this stay out of snapshots: such
/// nodes, mostly inline scripts, styles, SVG paths and embedded data, are read
/// individually if JavaScript asks for them.
const LARGE_TEXT_BYTES: usize = 4096;
const ABSENT: u32 = u32::MAX;
const HAS_START_INDEX: u32 = 1;
const HAS_END_INDEX: u32 = 2;
const HAS_NAMESPACE: u32 = 4;
const EMPTY_ATTRIBUTE_MAPS: u32 = 8;
/// The record cannot be represented here; JavaScript reads it individually.
const OPAQUE: u32 = 16;
const RELEASED: u32 = 32;
const KINDS: [&str; 8] = [
    "tag",
    "text",
    "comment",
    "root",
    "script",
    "style",
    "directive",
    "cdata",
];
const SHORT_NAME_SLOTS: usize = 256;

pub(crate) struct NodeSnapshot {
    /// Consecutive ranges of nodes, encoded separately (in parallel for
    /// large trees) with references local to each chunk.
    chunks: Vec<Chunk>,
}

struct Chunk {
    is_encoded: bool,
    nodes: Vec<u32>,
    children: Vec<u32>,
    attributes: Vec<u32>,
    strings: Vec<u32>,
    text: String,
    units: u32,
}

impl NodeSnapshot {
    pub(crate) fn into_js(self, env: &Env) -> Result<JsObject> {
        let total = |part: fn(&Chunk) -> usize| self.chunks.iter().map(part).sum::<usize>();
        let lengths = [
            total(|chunk| chunk.nodes.len()),
            total(|chunk| chunk.children.len()),
            total(|chunk| chunk.attributes.len()),
            total(|chunk| chunk.strings.len()),
        ];
        let header = [
            lengths[0] as u32,
            lengths[1] as u32,
            lengths[2] as u32,
            lengths[3] as u32,
            u32::from(self.chunks.iter().any(|chunk| chunk.is_encoded)),
        ];
        let length = header.len() + lengths.iter().sum::<usize>();
        let data = uninitialized_words(env, length, |words| {
            words[..header.len()].copy_from_slice(&header);
            let (nodes, rest) = words[header.len()..].split_at_mut(lengths[0]);
            let (children, rest) = rest.split_at_mut(lengths[1]);
            let (attributes, strings) = rest.split_at_mut(lengths[2]);
            let mut bases = Bases::default();
            for chunk in &self.chunks {
                bases.copy(chunk, nodes, children, attributes, strings);
            }
        })?;
        let text = if self.chunks.len() == 1 {
            crate::codec::js_string(env, &self.chunks[0].text)?
        } else {
            let mut text =
                String::with_capacity(self.chunks.iter().map(|chunk| chunk.text.len()).sum());
            for chunk in &self.chunks {
                text.push_str(&chunk.text);
            }
            crate::codec::js_string(env, &text)?
        };
        let mut object = env.create_object()?;
        object.set_named_property("data", data)?;
        object.set_named_property("text", text)?;
        Ok(object)
    }
}

/// Where the next chunk's entries start in each combined list.
#[derive(Default)]
struct Bases {
    nodes: usize,
    children: usize,
    attributes: usize,
    strings: usize,
    units: u32,
}

impl Bases {
    /// Copies `chunk` after the chunks before it, shifting its references to
    /// children, attribute pairs, strings and text by theirs.
    fn copy(
        &mut self,
        chunk: &Chunk,
        nodes: &mut [u32],
        children: &mut [u32],
        attributes: &mut [u32],
        strings: &mut [u32],
    ) {
        let string_base = (self.strings / 2) as u32;
        let child_base = self.children as u32;
        let pair_base = (self.attributes / 2) as u32;
        let target = &mut nodes[self.nodes..self.nodes + chunk.nodes.len()];
        target.copy_from_slice(&chunk.nodes);
        if self.nodes != 0 {
            for fields in target.as_chunks_mut::<STRIDE>().0 {
                let flags = fields[10];
                if flags & RELEASED != 0 {
                    continue;
                }
                fields[0] += string_base;
                fields[4] += child_base;
                fields[8] += pair_base;
                for field in [6, 7, 14] {
                    if fields[field] != 0 {
                        fields[field] += string_base;
                    }
                }
                if flags & HAS_NAMESPACE != 0 {
                    fields[13] += string_base;
                }
            }
        }
        children[self.children..self.children + chunk.children.len()]
            .copy_from_slice(&chunk.children);
        let target = &mut attributes[self.attributes..self.attributes + chunk.attributes.len()];
        for (slot, reference) in target.iter_mut().zip(&chunk.attributes) {
            *slot = reference + string_base;
        }
        let target = &mut strings[self.strings..self.strings + chunk.strings.len()];
        for (slot, offset) in target.iter_mut().zip(&chunk.strings) {
            *slot = offset + self.units;
        }
        self.nodes += chunk.nodes.len();
        self.children += chunk.children.len();
        self.attributes += chunk.attributes.len();
        self.strings += chunk.strings.len();
        self.units += chunk.units;
    }
}

/// A `Uint32Array` of `length` words that `fill` writes. A Node buffer is
/// used for its storage because, unlike an `ArrayBuffer`, it is not
/// zero-filled first; `fill` writes every word before JavaScript can read it.
fn uninitialized_words(
    env: &Env,
    length: usize,
    fill: impl FnOnce(&mut [u32]),
) -> Result<JsTypedArray> {
    let raw_env = env.raw();
    let mut buffer = std::ptr::null_mut();
    let mut memory = std::ptr::null_mut();
    // SAFETY: Node-API calls on the current environment with valid out
    // pointers. `memory` is the buffer's own allocation of `length` words,
    // checked to be aligned, and the buffer stays alive in this handle scope.
    unsafe {
        check_status!(sys::napi_create_buffer(
            raw_env,
            length * 4,
            &mut memory,
            &mut buffer
        ))?;
        let mut kind = 0;
        let mut bytes = 0;
        let mut view_memory = std::ptr::null_mut();
        let mut arraybuffer = std::ptr::null_mut();
        let mut byte_offset = 0;
        check_status!(sys::napi_get_typedarray_info(
            raw_env,
            buffer,
            &mut kind,
            &mut bytes,
            &mut view_memory,
            &mut arraybuffer,
            &mut byte_offset,
        ))?;
        if !byte_offset.is_multiple_of(4)
            || !(memory as usize).is_multiple_of(4)
            || bytes < length * 4
        {
            return Err(napi::Error::from_reason("Unaligned snapshot buffer"));
        }
        let mut words = std::ptr::null_mut();
        check_status!(sys::napi_create_typedarray(
            raw_env,
            sys::TypedarrayType::uint32_array,
            length,
            arraybuffer,
            byte_offset,
            &mut words,
        ))?;
        fill(std::slice::from_raw_parts_mut(memory.cast::<u32>(), length));
        Ok(JsTypedArray::from_raw_unchecked(raw_env, words))
    }
}

/// The UTF-16 length of `text`: one unit per character, two for characters
/// beyond the basic plane, counted from UTF-8 lead bytes.
fn utf16_length(text: &str) -> usize {
    text.bytes()
        .map(|byte| usize::from(byte & 0xC0 != 0x80) + usize::from(byte >= 0xF0))
        .sum()
}

struct Builder {
    nodes: Vec<u32>,
    children: Vec<u32>,
    attributes: Vec<u32>,
    strings: Vec<u32>,
    text: String,
    units: u32,
    interned: IdMap<String, u32>,
    /// References of the common node types, resolved without hashing.
    kinds: [Option<u32>; KINDS.len()],
    /// Recently interned names of up to eight bytes, keyed by their bytes:
    /// element and attribute names repeat across nodes.
    short_names: Box<[(u64, u8, u32); SHORT_NAME_SLOTS]>,
    /// html5ever names are atoms that hash and compare by identity.
    local_names: IdMap<LocalName, u32>,
    namespaces: IdMap<Namespace, u32>,
    codec: bool,
    is_encoded: bool,
}

/// Nodes per chunk worth encoding on another thread.
const PARALLEL_CHUNK_NODES: usize = 8192;

pub(crate) fn build(document: &NativeDocument) -> NodeSnapshot {
    let codec = document.options.get("__utf16Codec") == Some(&Value::Bool(true))
        || document.options.get("__losslessUnicode") == Some(&Value::Bool(true));
    if let Some(arena) = document.arena.borrow().as_ref() {
        let chunks =
            crate::runtime::chunked_map(arena.nodes.len(), PARALLEL_CHUNK_NODES, |range| {
                let mut builder = Builder::new(range.len(), 0, codec);
                for id in range {
                    match arena.node(id as u32) {
                        Some(node) => builder.encode(node),
                        None => builder.released(),
                    }
                }
                vec![builder.finish()]
            });
        return NodeSnapshot { chunks };
    }
    let mut builder = Builder::new(
        document.slot_count() as usize,
        document.content_bytes.get(),
        codec,
    );
    builder.encode_immutable(document);
    NodeSnapshot {
        chunks: vec![builder.finish()],
    }
}

/// The JSON fields a document root's record carries, as `convert_node` sets them.
fn quirks_mode_json(mode: html5ever::tree_builder::QuirksMode) -> &'static str {
    match mode {
        html5ever::tree_builder::QuirksMode::Quirks => r#"{"x-mode":"quirks"}"#,
        html5ever::tree_builder::QuirksMode::LimitedQuirks => r#"{"x-mode":"limited-quirks"}"#,
        html5ever::tree_builder::QuirksMode::NoQuirks => r#"{"x-mode":"no-quirks"}"#,
    }
}

/// The JSON fields a doctype's record carries, as `convert_node` sets them.
fn doctype_fields_json(doctype: &scraper::node::Doctype) -> String {
    let quoted = |value: &str| serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"{{"x-name":{},"x-publicId":{},"x-systemId":{}}}"#,
        quoted(doctype.name()),
        quoted(doctype.public_id()),
        quoted(doctype.system_id())
    )
}

fn pointer(value: Option<u32>) -> u32 {
    value.map_or(0, |id| id + 1)
}

impl Builder {
    fn new(count: usize, text_bytes: usize, codec: bool) -> Self {
        Self {
            nodes: Vec::with_capacity(count * STRIDE),
            children: Vec::with_capacity(count),
            attributes: Vec::new(),
            strings: Vec::with_capacity(count * 2),
            text: String::with_capacity(text_bytes),
            units: 0,
            interned: IdMap::with_capacity_and_hasher(32, Default::default()),
            kinds: [None; KINDS.len()],
            short_names: Box::new([(0, 0, 0); SHORT_NAME_SLOTS]),
            local_names: IdMap::with_capacity_and_hasher(32, Default::default()),
            namespaces: IdMap::default(),
            codec,
            is_encoded: false,
        }
    }

    fn finish(self) -> Chunk {
        Chunk {
            is_encoded: self.is_encoded,
            nodes: self.nodes,
            children: self.children,
            attributes: self.attributes,
            strings: self.strings,
            text: self.text,
            units: self.units,
        }
    }

    fn string(&mut self, value: &str) -> u32 {
        let start = self.units;
        self.text.push_str(value);
        let units = if value.is_ascii() {
            value.len()
        } else {
            self.is_encoded |= self.codec && crate::codec::has_encoding(value);
            utf16_length(value)
        };
        self.units += units as u32;
        self.strings.push(start);
        self.strings.push(self.units);
        (self.strings.len() / 2 - 1) as u32
    }

    fn kind(&mut self, kind: &str) -> u32 {
        let Some(slot) = KINDS.iter().position(|known| *known == kind) else {
            return self.interned(kind);
        };
        if let Some(reference) = self.kinds[slot] {
            return reference;
        }
        let reference = self.interned(kind);
        self.kinds[slot] = Some(reference);
        reference
    }

    fn interned_name(&mut self, name: &str) -> u32 {
        let bytes = name.as_bytes();
        if bytes.len() > 8 {
            return self.interned(name);
        }
        let mut word = [0; 8];
        word[..bytes.len()].copy_from_slice(bytes);
        let key = u64::from_le_bytes(word);
        let length = bytes.len() as u8;
        let slot = (key
            .wrapping_add(u64::from(length))
            .wrapping_mul(0x9E37_79B9_7F4A_7C15)
            >> 56) as usize;
        let (cached_key, cached_length, cached) = self.short_names[slot];
        if cached != 0 && cached_key == key && cached_length == length {
            return cached - 1;
        }
        let reference = self.interned(name);
        self.short_names[slot] = (key, length, reference + 1);
        reference
    }

    fn interned(&mut self, value: &str) -> u32 {
        if let Some(reference) = self.interned.get(value) {
            return *reference;
        }
        let reference = self.string(value);
        self.interned.insert(value.to_owned(), reference);
        reference
    }

    fn local_name(&mut self, name: &LocalName) -> u32 {
        if let Some(reference) = self.local_names.get(name) {
            return *reference;
        }
        let reference = self.interned(name);
        self.local_names.insert(name.clone(), reference);
        reference
    }

    fn namespace(&mut self, namespace: &Namespace) -> u32 {
        if let Some(reference) = self.namespaces.get(namespace) {
            return *reference;
        }
        let reference = self.interned(namespace);
        self.namespaces.insert(namespace.clone(), reference);
        reference
    }

    fn released(&mut self) {
        let mut fields = [0; STRIDE];
        fields[10] = RELEASED;
        self.nodes.extend_from_slice(&fields);
    }

    fn encode(&mut self, node: &DomNode) {
        let mut fields = [0; STRIDE];
        fields[0] = self.kind(&node.kind);
        fields[1] = pointer(node.parent);
        fields[2] = pointer(node.prev);
        fields[3] = pointer(node.next);
        fields[4] = self.children.len() as u32;
        fields[5] = node.children.len() as u32;
        self.children.extend_from_slice(&node.children);
        fields[6] = node
            .name
            .as_deref()
            .map_or(0, |name| self.interned_name(name) + 1);
        let mut flags = 0;
        match node.data.as_deref() {
            Some(data) if data.len() > LARGE_TEXT_BYTES => flags |= OPAQUE,
            Some(data) => fields[7] = self.string(data) + 1,
            None => {}
        }
        fields[8] = (self.attributes.len() / 2) as u32;
        let has_large_attribute = node.attribs.values().any(|value| {
            value
                .as_str()
                .is_some_and(|value| value.len() > LARGE_TEXT_BYTES)
        });
        if has_large_attribute {
            flags |= OPAQUE;
        } else {
            fields[9] = node.attribs.len() as u32;
        }
        for (name, value) in node.attribs.iter().filter(|_| !has_large_attribute) {
            let Some(value) = value.as_str() else {
                flags |= OPAQUE;
                break;
            };
            let name = self.interned_name(name);
            let value = self.string(value);
            self.attributes.extend_from_slice(&[name, value]);
        }
        fields[11] = ABSENT;
        fields[12] = ABSENT;
        let mut rest = Map::new();
        if let Some(namespace) = &node.namespace {
            flags |= HAS_NAMESPACE;
            fields[13] = self.interned(namespace);
        }
        match (&node.attribs_namespace, &node.attribs_prefix) {
            (Some(namespaces), Some(prefixes)) if namespaces.is_empty() && prefixes.is_empty() => {
                flags |= EMPTY_ATTRIBUTE_MAPS;
            }
            (namespaces, prefixes) => {
                if let Some(namespaces) = namespaces {
                    rest.insert(
                        "attribsNamespace".into(),
                        Value::Object((**namespaces).clone()),
                    );
                }
                if let Some(prefixes) = prefixes {
                    rest.insert("attribsPrefix".into(), Value::Object((**prefixes).clone()));
                }
            }
        }
        for (key, value) in &node.extras {
            let index = value.as_u64().filter(|index| *index < u64::from(ABSENT));
            match (key.as_str(), value) {
                ("startIndex", Value::Null) => flags |= HAS_START_INDEX,
                ("startIndex", _) if index.is_some() => {
                    flags |= HAS_START_INDEX;
                    fields[11] = index.unwrap() as u32;
                }
                ("endIndex", Value::Null) => flags |= HAS_END_INDEX,
                ("endIndex", _) if index.is_some() => {
                    flags |= HAS_END_INDEX;
                    fields[12] = index.unwrap() as u32;
                }
                _ => {
                    rest.insert(key.clone(), value.clone());
                }
            }
        }
        if !rest.is_empty() {
            match serde_json::to_string(&rest) {
                Ok(json) => fields[14] = self.interned(&json) + 1,
                Err(_) => flags |= OPAQUE,
            }
        }
        fields[10] = flags;
        self.nodes.extend_from_slice(&fields);
    }

    /// Mirrors `NativeDocument::immutable_dom_node` without building records
    /// for elements, text and comments; other nodes use that record directly.
    fn encode_immutable(&mut self, document: &NativeDocument) {
        let html = document.html.borrow();
        let ids = document.ids.borrow();
        let reverse = document.reverse.borrow();
        let Some(html) = html.as_ref() else {
            return;
        };
        let local = |node: Option<ego_tree::NodeRef<'_, Node>>| {
            node.and_then(|node| reverse.get(&node.id()).copied())
        };
        let text_type = self.interned("text");
        let comment_type = self.interned("comment");
        let tag_type = self.interned("tag");
        let script_type = self.interned("script");
        let style_type = self.interned("style");
        for (index, node_id) in ids.iter().enumerate() {
            let Some(node) = html.tree.get(*node_id) else {
                self.released();
                continue;
            };
            let is_plain_element = matches!(node.value(), Node::Element(element)
                if element.name.prefix.is_none()
                    && element.attrs.iter().all(|(name, _)| name.ns.is_empty() && name.prefix.is_none()));
            let is_direct = is_plain_element
                || matches!(
                    node.value(),
                    Node::Text(_)
                        | Node::Comment(_)
                        | Node::Document
                        | Node::Fragment
                        | Node::Doctype(_)
                );
            if !is_direct {
                match document.immutable_dom_node(index as u32) {
                    Some(record) => self.encode(&record),
                    None => self.released(),
                }
                continue;
            }
            let mut fields = [0; STRIDE];
            fields[1] = pointer(local(node.parent()));
            fields[2] = pointer(local(node.prev_sibling()));
            fields[3] = pointer(local(node.next_sibling()));
            fields[4] = self.children.len() as u32;
            let first_child = self.children.len();
            self.children.extend(
                node.children()
                    .filter_map(|child| reverse.get(&child.id()).copied()),
            );
            fields[5] = (self.children.len() - first_child) as u32;
            fields[8] = (self.attributes.len() / 2) as u32;
            fields[11] = ABSENT;
            fields[12] = ABSENT;
            let mut flags = HAS_START_INDEX | HAS_END_INDEX;
            match node.value() {
                Node::Document => {
                    fields[0] = self.interned("root");
                    fields[14] = self.interned(quirks_mode_json(html.quirks_mode)) + 1;
                    flags = 0;
                }
                Node::Fragment => {
                    fields[0] = self.interned("root");
                    flags = 0;
                }
                Node::Doctype(doctype) => {
                    fields[0] = self.interned("directive");
                    fields[6] = self.interned("!doctype") + 1;
                    fields[7] = self.string(&crate::doctype_content(doctype)) + 1;
                    fields[14] = self.interned(&doctype_fields_json(doctype)) + 1;
                    flags = 0;
                }
                Node::Text(text) => {
                    fields[0] = text_type;
                    if text.len() > LARGE_TEXT_BYTES {
                        flags |= OPAQUE;
                    } else {
                        fields[7] = self.string(text) + 1;
                    }
                }
                Node::Comment(comment) => {
                    fields[0] = comment_type;
                    if comment.len() > LARGE_TEXT_BYTES {
                        flags |= OPAQUE;
                    } else {
                        fields[7] = self.string(comment) + 1;
                    }
                }
                Node::Element(element) => {
                    fields[0] = match element.name() {
                        "script" => script_type,
                        "style" => style_type,
                        _ => tag_type,
                    };
                    fields[6] = self.local_name(&element.name.local) + 1;
                    if element
                        .attrs
                        .iter()
                        .any(|(_, value)| value.len() > LARGE_TEXT_BYTES)
                    {
                        flags |= OPAQUE;
                    } else {
                        for (attribute, value) in &element.attrs {
                            let attribute = self.local_name(&attribute.local);
                            let value = self.string(value);
                            self.attributes.extend_from_slice(&[attribute, value]);
                        }
                        fields[9] = element.attrs.len() as u32;
                    }
                    fields[13] = self.namespace(&element.name.ns);
                    flags |= HAS_NAMESPACE | EMPTY_ATTRIBUTE_MAPS;
                }
                _ => unreachable!("other node types use the record path"),
            }
            fields[10] = flags;
            self.nodes.extend_from_slice(&fields);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{latin1_bytes, utf16_units};

    #[test]
    fn transcodes_text_like_the_standard_library() {
        for text in [
            "",
            "ascii only",
            "café ©",
            "번개장터 “quoted” — dash",
            "emoji 😀 and \u{e800}",
            "\u{ff}\u{100}",
            "a\u{10ffff}b",
        ] {
            let expected: Vec<u16> = text.encode_utf16().collect();
            assert_eq!(utf16_units(text), expected, "{text}");
            assert_eq!(utf16_length(text), expected.len(), "{text}");
            let latin1 = latin1_bytes(text);
            assert_eq!(
                latin1.is_some(),
                text.chars().all(|character| (character as u32) < 0x100),
                "{text}"
            );
            if let Some(bytes) = latin1 {
                assert_eq!(
                    bytes
                        .iter()
                        .map(|byte| u16::from(*byte))
                        .collect::<Vec<_>>(),
                    expected
                );
            }
        }
    }
}
