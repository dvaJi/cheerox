//! Mutable, stable-ID DOM storage. All mutations stay on the native side.
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use napi::{Error, Result, Status};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct DomNode {
    #[serde(default)]
    pub id: u32,
    #[serde(rename = "type", default = "root_kind")]
    pub kind: Cow<'static, str>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(default)]
    pub attribs: Attributes,
    #[serde(default)]
    pub children: Vec<u32>,
    #[serde(default)]
    pub parent: Option<u32>,
    #[serde(default)]
    pub prev: Option<u32>,
    #[serde(default)]
    pub next: Option<u32>,
    /// Element namespace; borrowed for the namespaces HTML parsing produces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<Cow<'static, str>>,
    /// parse5's per-attribute namespace and prefix maps, when the node has them.
    #[serde(
        rename = "attribsNamespace",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub attribs_namespace: Option<Box<Map<String, Value>>>,
    #[serde(
        rename = "attribsPrefix",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub attribs_prefix: Option<Box<Map<String, Value>>>,
    #[serde(flatten)]
    pub extras: FieldMap,
}

/// An element's attributes in insertion order. Elements have few, so a list
/// searched linearly costs one allocation and no hashing, where a map costs
/// three and a hash per name.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Attributes(Vec<(String, Value)>);

impl Attributes {
    pub(crate) fn with_capacity(capacity: usize) -> Self {
        Self(Vec::with_capacity(capacity))
    }

    pub(crate) fn get(&self, name: &str) -> Option<&Value> {
        self.0
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value)
    }

    pub(crate) fn contains_key(&self, name: &str) -> bool {
        self.0.iter().any(|(key, _)| key == name)
    }

    /// Sets `name`, in place if present, as a map insert does.
    pub(crate) fn insert(&mut self, name: String, value: Value) -> Option<Value> {
        match self.0.iter_mut().find(|(key, _)| *key == name) {
            Some((_, slot)) => Some(std::mem::replace(slot, value)),
            None => {
                self.0.push((name, value));
                None
            }
        }
    }

    /// Adds `name` unless present, keeping the first value as htmlparser2 does.
    /// Past a few attributes, the caller dedupes with a set instead.
    pub(crate) fn push_unique(&mut self, name: String, value: Value) {
        if !self.contains_key(&name) {
            self.0.push((name, value));
        }
    }

    pub(crate) fn push(&mut self, name: String, value: Value) {
        self.0.push((name, value));
    }

    /// Removes `name`, keeping the order of the rest.
    pub(crate) fn shift_remove(&mut self, name: &str) -> Option<Value> {
        let index = self.0.iter().position(|(key, _)| key == name)?;
        Some(self.0.remove(index).1)
    }

    pub(crate) fn len(&self) -> usize {
        self.0.len()
    }

    pub(crate) fn iter(&self) -> <&Self as IntoIterator>::IntoIter {
        self.into_iter()
    }

    pub(crate) fn values(&self) -> impl Iterator<Item = &Value> {
        self.0.iter().map(|(_, value)| value)
    }

    pub(crate) fn to_map(&self) -> Map<String, Value> {
        self.0.iter().cloned().collect()
    }
}

impl From<Map<String, Value>> for Attributes {
    fn from(map: Map<String, Value>) -> Self {
        Self(map.into_iter().collect())
    }
}

impl<'a> IntoIterator for &'a Attributes {
    type Item = (&'a String, &'a Value);
    type IntoIter = std::iter::Map<
        std::slice::Iter<'a, (String, Value)>,
        fn(&'a (String, Value)) -> (&'a String, &'a Value),
    >;
    fn into_iter(self) -> Self::IntoIter {
        self.0.iter().map(|(key, value)| (key, value))
    }
}

impl IntoIterator for Attributes {
    type Item = (String, Value);
    type IntoIter = std::vec::IntoIter<(String, Value)>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}

impl Serialize for Attributes {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for Attributes {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        Map::deserialize(deserializer).map(Self::from)
    }
}

/// A string-keyed map that most nodes leave empty, boxed so that an empty
/// one costs a pointer instead of a whole map in every node.
#[derive(Clone, Debug, Default)]
pub(crate) struct FieldMap(Option<Box<Map<String, Value>>>);

static EMPTY_FIELDS: std::sync::LazyLock<Map<String, Value>> = std::sync::LazyLock::new(Map::new);

impl std::ops::Deref for FieldMap {
    type Target = Map<String, Value>;
    fn deref(&self) -> &Self::Target {
        self.0.as_deref().unwrap_or(&EMPTY_FIELDS)
    }
}

impl std::ops::DerefMut for FieldMap {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.0.get_or_insert_with(Box::default)
    }
}

impl From<Map<String, Value>> for FieldMap {
    fn from(map: Map<String, Value>) -> Self {
        Self((!map.is_empty()).then(|| Box::new(map)))
    }
}

/// Removals and lookups for writing leave an empty map unallocated; other
/// writes go through `DerefMut`, which allocates it.
impl FieldMap {
    pub(crate) fn into_map(self) -> Map<String, Value> {
        self.0.map_or_else(Map::new, |map| *map)
    }

    pub(crate) fn get_mut(&mut self, key: &str) -> Option<&mut Value> {
        self.0.as_mut()?.get_mut(key)
    }

    pub(crate) fn remove(&mut self, key: &str) -> Option<Value> {
        self.0.as_mut()?.remove(key)
    }
}

impl<'a> IntoIterator for &'a FieldMap {
    type Item = (&'a String, &'a Value);
    type IntoIter = serde_json::map::Iter<'a>;
    fn into_iter(self) -> Self::IntoIter {
        (**self).iter()
    }
}

impl<'a> IntoIterator for &'a mut FieldMap {
    type Item = (&'a String, &'a mut Value);
    type IntoIter = serde_json::map::IterMut<'a>;
    fn into_iter(self) -> Self::IntoIter {
        (**self).iter_mut()
    }
}

impl IntoIterator for FieldMap {
    type Item = (String, Value);
    type IntoIter = serde_json::map::IntoIter;
    fn into_iter(self) -> Self::IntoIter {
        self.into_map().into_iter()
    }
}

impl Serialize for FieldMap {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        (**self).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for FieldMap {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        Map::deserialize(deserializer).map(Self::from)
    }
}

fn root_kind() -> Cow<'static, str> {
    Cow::Borrowed("root")
}

pub(crate) const HTML_NAMESPACE: &str = "http://www.w3.org/1999/xhtml";

/// A namespace, borrowed for the ones HTML parsing produces.
pub(crate) fn namespace_name(namespace: &str) -> Cow<'static, str> {
    match namespace {
        HTML_NAMESPACE => Cow::Borrowed(HTML_NAMESPACE),
        "http://www.w3.org/2000/svg" => Cow::Borrowed("http://www.w3.org/2000/svg"),
        "http://www.w3.org/1998/Math/MathML" => Cow::Borrowed("http://www.w3.org/1998/Math/MathML"),
        "http://www.w3.org/1999/xlink" => Cow::Borrowed("http://www.w3.org/1999/xlink"),
        "http://www.w3.org/XML/1998/namespace" => {
            Cow::Borrowed("http://www.w3.org/XML/1998/namespace")
        }
        "http://www.w3.org/2000/xmlns/" => Cow::Borrowed("http://www.w3.org/2000/xmlns/"),
        other => Cow::Owned(other.to_owned()),
    }
}

/// A node type, borrowed for the types the DOM defines.
pub(crate) fn node_kind(kind: &str) -> Cow<'static, str> {
    match kind {
        "tag" => Cow::Borrowed("tag"),
        "text" => Cow::Borrowed("text"),
        "root" => Cow::Borrowed("root"),
        "script" => Cow::Borrowed("script"),
        "style" => Cow::Borrowed("style"),
        "comment" => Cow::Borrowed("comment"),
        "directive" => Cow::Borrowed("directive"),
        "cdata" => Cow::Borrowed("cdata"),
        "doctype" => Cow::Borrowed("doctype"),
        other => Cow::Owned(other.to_owned()),
    }
}

impl DomNode {
    pub(crate) fn new(kind: impl Into<Cow<'static, str>>) -> Self {
        Self {
            id: 0,
            kind: kind.into(),
            name: None,
            data: None,
            attribs: Attributes::default(),
            children: Vec::new(),
            parent: None,
            prev: None,
            next: None,
            namespace: None,
            attribs_namespace: None,
            attribs_prefix: None,
            extras: FieldMap::default(),
        }
    }
    pub(crate) fn is_element(&self) -> bool {
        matches!(self.kind.as_ref(), "tag" | "script" | "style")
    }
    pub(crate) fn content_bytes(&self) -> usize {
        let attributes: usize = self
            .attribs
            .values()
            .filter_map(Value::as_str)
            .map(str::len)
            .sum();
        self.data.as_ref().map_or(0, String::len) + attributes
    }
}

#[derive(Clone, Debug)]
pub(crate) struct DomArena {
    pub nodes: Vec<DomNode>,
    pub options: Value,
    pub free: Vec<u32>,
    /// Parents whose child lists changed since JavaScript last asked, so it
    /// can refresh the child arrays it holds without rereading every node.
    pub touched: Vec<u32>,
    /// Too many changes were recorded to list; every parent counts as touched.
    pub touched_overflow: bool,
    /// Whether parsing records start and end indices, read once per parse.
    pub parse_indices: Option<(bool, bool)>,
    /// Nodes removed from a parent since the last collection.
    pub detached_since_collection: u32,
    /// Live nodes after the last collection, or when the arena was built.
    pub collected_live: u32,
    /// Elements by ASCII-lowercased name, in document order, as parsing
    /// created them; dropped before any write, which may reorder ids.
    pub name_index: Option<NameIndex>,
}

pub(crate) type NameIndex = crate::id_hash::IdMap<String, Vec<u32>>;

const TOUCHED_LIMIT: usize = 1 << 16;

impl DomArena {
    /// An arena over records whose ids and links are already consistent, as
    /// a parse tree's conversion produces them.
    pub(crate) fn from_linked_records(nodes: Vec<DomNode>, options: Value) -> Self {
        let slots = nodes.len() as u32;
        Self {
            nodes,
            options,
            free: Vec::new(),
            touched: Vec::new(),
            touched_overflow: false,
            parse_indices: None,
            detached_since_collection: 0,
            collected_live: slots,
            name_index: None,
        }
    }
    pub(crate) fn from_records(mut nodes: Vec<DomNode>, options: Value) -> Self {
        for (id, node) in nodes.iter_mut().enumerate() {
            node.id = id as u32;
        }
        let slots = nodes.len() as u32;
        let mut arena = Self {
            nodes,
            options,
            free: Vec::new(),
            touched: Vec::new(),
            touched_overflow: false,
            parse_indices: None,
            detached_since_collection: 0,
            collected_live: slots,
            name_index: None,
        };
        for id in 0..arena.nodes.len() {
            arena.relink(id as u32);
        }
        arena.take_touched();
        arena
    }
    pub(crate) fn touch(&mut self, parent: u32) {
        if self.touched_overflow {
            return;
        }
        if self.touched.len() >= TOUCHED_LIMIT {
            self.touched = Vec::new();
            self.touched_overflow = true;
        } else {
            self.touched.push(parent);
        }
    }
    /// The parents touched since the last call, or `None` when too many were.
    pub(crate) fn take_touched(&mut self) -> Option<Vec<u32>> {
        let touched = std::mem::take(&mut self.touched);
        let overflow = std::mem::replace(&mut self.touched_overflow, false);
        (!overflow).then_some(touched)
    }
    fn note_detached(&mut self) {
        self.detached_since_collection = self.detached_since_collection.saturating_add(1);
    }
    /// Every live node that `root` does not reach through child links.
    pub(crate) fn detached_slots(&self, root: u32) -> Vec<u32> {
        let mut attached = vec![false; self.nodes.len()];
        let mut stack = vec![root];
        while let Some(id) = stack.pop() {
            let Some(node) = self.node(id) else { continue };
            if std::mem::replace(&mut attached[id as usize], true) {
                continue;
            }
            stack.extend(node.children.iter().copied());
        }
        (0..self.nodes.len() as u32)
            .filter(|id| !attached[*id as usize] && self.node(*id).is_some())
            .collect()
    }
    /// Whether removed nodes may have left enough garbage to collect: the
    /// live slots have grown by half since the last collection.
    pub(crate) fn is_collection_due(&self) -> bool {
        let live = self.nodes.len().saturating_sub(self.free.len()) as u64;
        self.detached_since_collection > 0 && live >= u64::from(self.collected_live) * 3 / 2 + 256
    }
    pub(crate) fn node(&self, id: u32) -> Option<&DomNode> {
        self.nodes
            .get(id as usize)
            .filter(|node| node.kind != "released")
    }
    pub(crate) fn node_mut(&mut self, id: u32) -> Option<&mut DomNode> {
        self.nodes
            .get_mut(id as usize)
            .filter(|node| node.kind != "released")
    }
    pub(crate) fn xml_mode(&self) -> bool {
        xml_mode(&self.options)
    }
    pub(crate) fn push(&mut self, mut node: DomNode) -> u32 {
        while let Some(id) = self.free.pop() {
            if self
                .nodes
                .get(id as usize)
                .is_some_and(|old| old.kind == "released")
            {
                node.id = id;
                self.nodes[id as usize] = node;
                return id;
            }
        }
        let id = self.nodes.len() as u32;
        node.id = id;
        self.nodes.push(node);
        id
    }
    pub(crate) fn attr(&self, id: u32, name: &str) -> Option<&str> {
        self.node(id)?.attribs.get(name)?.as_str()
    }
    pub(crate) fn set_attr(&mut self, ids: &[u32], name: &str, value: Option<&str>) {
        for id in ids {
            if let Some(node) = self.nodes.get_mut(*id as usize) {
                if node.is_element() {
                    match value {
                        Some(value) => {
                            node.attribs
                                .insert(name.into(), Value::String(value.into()));
                        }
                        None => {
                            node.attribs.shift_remove(name);
                        }
                    }
                }
            }
        }
    }
    pub(crate) fn relink(&mut self, parent: u32) {
        self.touch(parent);
        let children = self
            .nodes
            .get(parent as usize)
            .map(|node| node.children.clone())
            .unwrap_or_default();
        for (index, child) in children.iter().enumerate() {
            if let Some(node) = self.nodes.get_mut(*child as usize) {
                node.parent = Some(parent);
                node.prev = index
                    .checked_sub(1)
                    .and_then(|index| children.get(index))
                    .copied();
                node.next = children.get(index + 1).copied();
            }
        }
    }
    pub(crate) fn detach(&mut self, id: u32) {
        if let Some(parent) = self.node(id).and_then(|node| node.parent) {
            self.note_detached();
            if let Some(node) = self.nodes.get_mut(parent as usize) {
                node.children.retain(|child| *child != id);
            }
            self.relink(parent);
        }
        if let Some(node) = self.nodes.get_mut(id as usize) {
            node.parent = None;
            node.prev = None;
            node.next = None;
        }
    }
    pub(crate) fn detach_many(&mut self, ids: &[u32]) {
        if ids.len() < 2 {
            if let Some(id) = ids.first() {
                self.detach(*id);
            }
            return;
        }
        let removed: HashSet<_> = ids.iter().copied().collect();
        for id in ids {
            if self.node(*id).is_some_and(|node| node.parent.is_some()) {
                self.note_detached();
            }
        }
        let parents: HashSet<_> = ids
            .iter()
            .filter_map(|id| self.node(*id).and_then(|node| node.parent))
            .collect();
        for parent in parents {
            if let Some(node) = self.nodes.get_mut(parent as usize) {
                node.children.retain(|child| !removed.contains(child));
            }
            self.relink(parent);
        }
        for id in removed {
            if let Some(node) = self.nodes.get_mut(id as usize) {
                node.parent = None;
                node.prev = None;
                node.next = None;
            }
        }
    }
    pub(crate) fn set_children(&mut self, parent: u32, children: &[u32]) {
        if self.node(parent).is_none() {
            return;
        }
        if !self
            .node(parent)
            .is_some_and(|node| node.is_element() || node.kind == "root" || node.kind == "cdata")
        {
            return;
        }
        let old = std::mem::take(&mut self.nodes[parent as usize].children);
        self.detach_many(&old);
        let mut seen = HashSet::new();
        let mut children: Vec<_> = children
            .iter()
            .rev()
            .copied()
            .filter(|id| *id != parent && self.node(*id).is_some() && seen.insert(*id))
            .collect();
        children.reverse();
        self.detach_many(&children);
        self.nodes[parent as usize].children = children;
        self.relink(parent);
    }
    pub(crate) fn text(&self, ids: &[u32]) -> String {
        let mut output = String::new();
        for id in ids {
            let mut stack = vec![*id];
            let mut visited = HashSet::new();
            while let Some(id) = stack.pop() {
                if !visited.insert(id) {
                    continue;
                }
                if let Some(node) = self.node(id) {
                    if node.kind == "text" {
                        output.push_str(node.data.as_deref().unwrap_or(""));
                    } else {
                        stack.extend(node.children.iter().rev().copied());
                    }
                }
            }
        }
        output
    }
    pub(crate) fn set_text(&mut self, ids: &[u32], value: &str) {
        for id in ids {
            if self
                .node(*id)
                .is_some_and(|node| node.is_element() || node.kind == "root")
            {
                self.set_children(*id, &[]);
                if !value.is_empty() {
                    let mut text = DomNode::new("text");
                    text.data = Some(value.into());
                    let child = self.push(text);
                    self.set_children(*id, &[child]);
                }
            }
        }
    }
    pub(crate) fn inner_html(&self, id: u32) -> String {
        self.outer_html(
            self.node(id)
                .map(|node| node.children.as_slice())
                .unwrap_or(&[]),
        )
    }
    pub(crate) fn inner_html_mut(&mut self, id: u32) -> String {
        if !self.xml_mode() && self.options.get("_useHtmlParser2") != Some(&Value::Bool(true)) {
            if let Some(node) = self.node(id) {
                let mut children = node.children.clone();
                let mut index = 0;
                while index < children.len() {
                    if let Some(root) = self
                        .node(children[index])
                        .filter(|node| node.kind == "root")
                    {
                        let contents = root.children.clone();
                        children.splice(index..index + 1, contents);
                    }
                    index += 1;
                }
                self.nodes[id as usize].children = children;
                self.touch(id);
            }
        }
        if self.xml_mode() || self.options.get("_useHtmlParser2") != Some(&Value::Bool(true)) {
            return self.inner_html(id);
        }
        let children = self
            .node(id)
            .map(|node| node.children.clone())
            .unwrap_or_default();
        self.serialize_mut(&children, &self.options.clone())
    }
    pub(crate) fn outer_html(&self, ids: &[u32]) -> String {
        self.serialize(ids, &self.options)
    }
    pub(crate) fn serialize_mut(&mut self, ids: &[u32], options: &Value) -> String {
        let legacy = options.get("legacySerializer") == Some(&Value::Bool(true));
        if !legacy
            && !xml_mode(options)
            && options.get("_useHtmlParser2") == Some(&Value::Bool(true))
        {
            let mut stack: Vec<(u32, bool)> = ids.iter().rev().map(|id| (*id, false)).collect();
            let mut budget = self.nodes.len().saturating_mul(8).saturating_add(1024);
            while let Some((id, is_foreign)) = stack.pop() {
                if budget == 0 {
                    break;
                }
                budget -= 1;
                let Some(node) = self.node(id) else {
                    continue;
                };
                let name = node.name.as_deref().unwrap_or("");
                let corrected = is_foreign
                    .then(|| foreign_element_name(name))
                    .filter(|corrected| *corrected != name)
                    .map(str::to_owned);
                let has_foreign_content = node.is_element()
                    && ((is_foreign && !is_foreign_integration_child(self, node))
                        || matches!(name, "svg" | "math"));
                let children_are_foreign = if node.kind == "root" {
                    is_foreign
                } else {
                    has_foreign_content
                };
                stack.extend(
                    node.children
                        .iter()
                        .rev()
                        .map(|id| (*id, children_are_foreign)),
                );
                if let Some(name) = corrected {
                    self.nodes[id as usize].name = Some(name);
                    self.name_index = None;
                    self.touch(id);
                }
            }
        }
        self.serialize(ids, options)
    }
    pub(crate) fn serialize(&self, ids: &[u32], options: &Value) -> String {
        let mut output = String::new();
        let xml = xml_mode(options);
        let is_htmlparser2 = options.get("_useHtmlParser2") == Some(&Value::Bool(true));
        // dom-serializer 0.1.x (Cheerio 0.22.0): no foreign-name corrections,
        // no foreign-content escaping rules, svg rendered in XML mode.
        let legacy = options.get("legacySerializer") == Some(&Value::Bool(true));
        // Cheerio serializes HTML with parse5, which always escapes; only the
        // htmlparser2 serializer leaves entities alone when asked to.
        let is_parse5 = !xml && !is_htmlparser2;
        // 0.1.x encodes only when `decodeEntities` is truthy — an absent flag
        // (as on the bare module's `cheerio.xml()`) leaves text raw.
        let encode = if legacy {
            options
                .get("decodeEntities")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        } else {
            is_parse5
                || options
                    .get("encodeEntities")
                    .or_else(|| options.get("decodeEntities"))
                    != Some(&Value::Bool(false))
        };
        let is_utf8 = options.get("encodeEntities").and_then(Value::as_str) == Some("utf8");
        let mut stack: Vec<(u32, bool, bool)> =
            ids.iter().rev().map(|id| (*id, false, false)).collect();
        let mut budget = self.nodes.len().saturating_mul(8).saturating_add(1024);
        while let Some((id, close, is_foreign)) = stack.pop() {
            if budget == 0 {
                break;
            }
            budget -= 1;
            let Some(node) = self.node(id) else {
                continue;
            };
            if close {
                output.push_str("</");
                let name = node.name.as_deref().unwrap_or("");
                output.push_str(if is_foreign {
                    foreign_element_name(name)
                } else {
                    name
                });
                output.push('>');
                continue;
            }
            match node.kind.as_ref() {
                "root" => stack.extend(
                    node.children
                        .iter()
                        .rev()
                        .map(|id| (*id, false, is_foreign)),
                ),
                "text" => {
                    let raw = if legacy {
                        node.parent
                            .and_then(|id| self.node(id))
                            .is_some_and(|parent| {
                                matches!(
                                    parent.name.as_deref(),
                                    Some(
                                        "script"
                                            | "style"
                                            | "xmp"
                                            | "iframe"
                                            | "noembed"
                                            | "noframes"
                                            | "plaintext"
                                            | "noscript"
                                    )
                                )
                            })
                    } else {
                        !xml && !is_foreign
                            && node
                                .parent
                                .and_then(|id| self.node(id))
                                .is_some_and(|parent| {
                                    matches!(
                                        parent.name.as_deref(),
                                        Some(
                                            "script"
                                                | "style"
                                                | "xmp"
                                                | "iframe"
                                                | "noembed"
                                                | "noframes"
                                                | "plaintext"
                                                | "noscript"
                                        )
                                    ) && (!is_parse5
                                        || parent.name.as_deref() != Some("noscript")
                                        || options.get("scriptingEnabled")
                                            != Some(&Value::Bool(false)))
                                })
                    };
                    if raw || !encode {
                        output.push_str(node.data.as_deref().unwrap_or(""));
                    } else if legacy {
                        legacy_escape(node.data.as_deref().unwrap_or(""), &mut output);
                    } else {
                        escape(
                            node.data.as_deref().unwrap_or(""),
                            false,
                            xml || (is_htmlparser2 && (is_foreign || !is_utf8)),
                            is_utf8 && !xml && !is_foreign,
                            &mut output,
                        );
                    }
                }
                "comment" => {
                    output.push_str("<!--");
                    output.push_str(node.data.as_deref().unwrap_or(""));
                    output.push_str("-->");
                }
                "cdata" => {
                    output.push_str("<![CDATA[");
                    output.push_str(&self.text(&node.children));
                    output.push_str("]]>");
                }
                "directive" | "doctype" => {
                    output.push('<');
                    if is_parse5 && node.name.as_deref() == Some("!doctype") {
                        output.push_str("!DOCTYPE ");
                        output.push_str(
                            node.extras
                                .get("x-name")
                                .and_then(Value::as_str)
                                .unwrap_or("html"),
                        );
                    } else {
                        output.push_str(node.data.as_deref().unwrap_or(""));
                    }
                    output.push('>');
                }
                _ if node.is_element() => {
                    if legacy {
                        // dom-serializer 0.1.x rules: no foreign-content
                        // handling; an svg element (and its subtree) renders
                        // in XML mode; void elements render their children
                        // without a closing tag, as the original did.
                        let name = node.name.as_deref().unwrap_or("");
                        let in_svg = is_foreign;
                        let effective_xml = xml || in_svg || name == "svg";
                        output.push('<');
                        output.push_str(name);
                        let attributes = super::js_property_order(
                            node.attribs
                                .iter()
                                .map(|(name, value)| (name.as_str(), value)),
                        );
                        for (attr_name, value) in attributes {
                            let value = value
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| value.to_string());
                            output.push(' ');
                            output.push_str(attr_name);
                            if effective_xml || !value.is_empty() {
                                output.push_str("=\"");
                                if encode {
                                    legacy_escape(&value, &mut output);
                                } else {
                                    output.push_str(&value);
                                }
                                output.push('"');
                            }
                        }
                        if effective_xml && node.children.is_empty() {
                            output.push_str("/>");
                            continue;
                        }
                        output.push('>');
                        let single = html_parser_void(name);
                        if !single || effective_xml {
                            stack.push((id, true, in_svg));
                        }
                        stack.extend(
                            node.children
                                .iter()
                                .rev()
                                .map(|child| (*child, false, in_svg || name == "svg")),
                        );
                        continue;
                    }
                    let stored_name = node.name.as_deref().unwrap_or("");
                    let name = if is_foreign {
                        foreign_element_name(stored_name)
                    } else {
                        stored_name
                    };
                    let is_integration_child =
                        is_foreign && is_foreign_integration_child(self, node);
                    let has_foreign_content = is_htmlparser2
                        && !xml
                        && ((is_foreign && !is_integration_child)
                            || matches!(name, "svg" | "math"));
                    output.push('<');
                    output.push_str(name);
                    // parse5 qualifies foreign attributes; XML and htmlparser2
                    // rendering write the stored attribute names unchanged.
                    let qualifiers = is_parse5.then_some((
                        node.attribs_namespace.as_deref(),
                        node.attribs_prefix.as_deref(),
                    ));
                    let attributes = super::js_property_order(
                        node.attribs
                            .iter()
                            .map(|(name, value)| (name.as_str(), value)),
                    );
                    for (name, value) in attributes {
                        output.push(' ');
                        match qualifiers {
                            Some((namespaces, prefixes)) => super::push_attribute_name(
                                &mut output,
                                name,
                                namespaces
                                    .and_then(|map| map.get(name))
                                    .and_then(Value::as_str),
                                prefixes
                                    .and_then(|map| map.get(name))
                                    .and_then(Value::as_str),
                            ),
                            None => output.push_str(if has_foreign_content {
                                foreign_attribute_name(name)
                            } else {
                                name
                            }),
                        }
                        let value = value
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| value.to_string());
                        if !xml
                            && !has_foreign_content
                            && is_htmlparser2
                            && options.get("emptyAttrs") != Some(&Value::Bool(true))
                            && value.is_empty()
                        {
                            continue;
                        }
                        output.push_str("=\"");
                        if encode {
                            escape(
                                &value,
                                true,
                                xml || (is_htmlparser2 && (has_foreign_content || !is_utf8)),
                                is_utf8 && !xml && !has_foreign_content,
                                &mut output,
                            );
                        } else {
                            output.push_str(&value.replace('"', "&quot;"));
                        }
                        output.push('"');
                    }
                    let is_void = !xml
                        && !has_foreign_content
                        && (if is_parse5 {
                            node.namespace
                                .as_deref()
                                .is_none_or(|namespace| namespace == super::HTML_NS)
                                && super::void_name(name)
                        } else {
                            html_parser_void(name)
                        });
                    if (xml
                        || has_foreign_content
                        || (is_htmlparser2
                            && is_void
                            && options.get("selfClosingTags") == Some(&Value::Bool(true))))
                        && node.children.is_empty()
                        && options.get("selfClosingTags") != Some(&Value::Bool(false))
                    {
                        if !xml && !has_foreign_content {
                            output.push(' ');
                        }
                        output.push_str("/>");
                        continue;
                    }
                    output.push('>');
                    if is_void && (is_parse5 || node.children.is_empty()) {
                        continue;
                    }
                    if !is_void {
                        stack.push((id, true, is_foreign));
                    }
                    if is_parse5 && name == "template" {
                        if let Some(contents) = node.children.first().and_then(|id| self.node(*id))
                        {
                            stack.extend(
                                contents.children.iter().rev().map(|id| (*id, false, false)),
                            );
                        }
                    } else {
                        stack.extend(
                            node.children
                                .iter()
                                .rev()
                                .map(|id| (*id, false, has_foreign_content)),
                        );
                    }
                }
                _ => {}
            }
        }
        output
    }
    pub(crate) fn clone_ids(&mut self, ids: &[u32], deep: bool) -> Vec<u32> {
        ids.iter()
            .filter_map(|id| self.clone_branch(*id, deep))
            .collect()
    }
    fn clone_branch(&mut self, root: u32, deep: bool) -> Option<u32> {
        let mut node = self.node(root)?.clone();
        if node.is_element() {
            node.extras.remove("data");
        }
        let source_children = node.children.clone();
        node.children.clear();
        node.parent = None;
        node.prev = None;
        node.next = None;
        let new_root = self.push(node);
        if deep {
            let mut queue = vec![(new_root, source_children)];
            while let Some((parent, children)) = queue.pop() {
                for child in children {
                    if let Some(node) = self.node(child) {
                        let mut copy = node.clone();
                        if copy.is_element() {
                            copy.extras.remove("data");
                        }
                        let child_children = copy.children.clone();
                        copy.children.clear();
                        copy.parent = None;
                        copy.prev = None;
                        copy.next = None;
                        let id = self.push(copy);
                        self.nodes[parent as usize].children.push(id);
                        queue.push((id, child_children));
                    }
                }
                self.relink(parent);
            }
        }
        Some(new_root)
    }
    pub(crate) fn import(&mut self, records: &[DomNode], roots: &[u32]) -> Vec<u32> {
        self.import_internal(records, roots, true)
    }
    fn import_internal(
        &mut self,
        records: &[DomNode],
        roots: &[u32],
        detach_roots: bool,
    ) -> Vec<u32> {
        self.nodes.reserve(records.len());
        let mut mapping = HashMap::new();
        for record in records {
            let mut node = record.clone();
            node.children.clear();
            node.parent = None;
            node.prev = None;
            node.next = None;
            let id = self.push(node);
            mapping.insert(record.id, id);
        }
        for record in records {
            if let Some(id) = mapping.get(&record.id) {
                self.nodes[*id as usize].children = record
                    .children
                    .iter()
                    .filter_map(|child| mapping.get(child).copied())
                    .collect();
                self.relink(*id);
            }
        }
        let roots: Vec<_> = roots
            .iter()
            .filter_map(|root| mapping.get(root).copied())
            .collect();
        if detach_roots {
            self.detach_many(&roots);
        }
        roots
    }
    pub(crate) fn create_fragment(&mut self, html: &str, context: Option<u32>) -> Result<Vec<u32>> {
        let parsed = self.parse_fragment(html, context)?;
        let roots = parsed.nodes[0].children.clone();
        Ok(self.import_internal(&parsed.nodes, &roots, false))
    }
    /// Parses `html` as the children of `context`; only the context's name
    /// and namespace affect the result.
    fn parse_fragment(&self, html: &str, context: Option<u32>) -> Result<DomArena> {
        let (context_name, namespace) = self.fragment_context(context);
        let mut options = self.options.clone();
        if let Some(namespace) = namespace {
            options["__contextNamespace"] = Value::String(namespace);
        }
        let document =
            super::NativeDocument::parse_options(html, false, options, context_name.as_deref());
        document.ensure_arena()?;
        let parsed = document.arena.borrow_mut().take().unwrap();
        Ok(parsed)
    }
    fn fragment_context(&self, context: Option<u32>) -> (Option<String>, Option<String>) {
        let node = context.and_then(|id| self.node(id));
        (
            node.and_then(|node| node.name.clone()),
            node.and_then(|node| node.namespace.as_deref().map(str::to_owned)),
        )
    }
    pub(crate) fn set_html(&mut self, ids: &[u32], html: &str) -> Result<()> {
        // Each target receives its own copy; targets of the same element type
        // share one parse, since the result depends only on that context.
        let mut parsed: HashMap<(Option<String>, Option<String>), DomArena> = HashMap::new();
        for id in ids {
            let key = self.fragment_context(Some(*id));
            if !parsed.contains_key(&key) {
                let fragment = self.parse_fragment(html, Some(*id))?;
                parsed.insert(key.clone(), fragment);
            }
            let fragment = &parsed[&key];
            let roots = fragment.nodes[0].children.clone();
            let children = self.import_internal(&fragment.nodes, &roots, false);
            self.set_children(*id, &children);
        }
        Ok(())
    }
    pub(crate) fn insert(&mut self, targets: &[u32], ids: &[u32], position: &str) -> Vec<u32> {
        let mut inserted = Vec::new();
        for (index, target) in targets.iter().enumerate() {
            // As Cheerio, only nodes that can hold children are targets.
            if !self.node(*target).is_some_and(|node| {
                node.is_element() || matches!(node.kind.as_ref(), "root" | "cdata")
            }) {
                continue;
            }
            if matches!(position, "append" | "prepend")
                && !self
                    .node(*target)
                    .is_some_and(|node| node.is_element() || node.kind == "root")
            {
                continue;
            }
            let ids = if index + 1 == targets.len() {
                ids.to_vec()
            } else {
                self.clone_ids(ids, true)
            };
            let (parent, mut offset) = if matches!(position, "append" | "prepend") {
                (
                    *target,
                    if position == "append" {
                        self.nodes[*target as usize].children.len()
                    } else {
                        0
                    },
                )
            } else {
                let Some(parent) = self.nodes[*target as usize].parent else {
                    continue;
                };
                let at = self.nodes[parent as usize]
                    .children
                    .iter()
                    .position(|id| id == target)
                    .unwrap_or(0);
                (parent, at + usize::from(position == "after"))
            };
            let valid: Vec<_> = ids
                .iter()
                .copied()
                .filter(|id| *id != parent && self.node(*id).is_some())
                .collect();
            let removed: HashSet<_> = valid.iter().copied().collect();
            offset -= self.nodes[parent as usize]
                .children
                .iter()
                .take(offset)
                .filter(|id| removed.contains(id))
                .count();
            self.detach_many(&valid);
            let mut seen = HashSet::new();
            let mut moved: Vec<_> = valid
                .iter()
                .rev()
                .copied()
                .filter(|id| seen.insert(*id))
                .collect();
            moved.reverse();
            let offset = offset.min(self.nodes[parent as usize].children.len());
            self.nodes[parent as usize]
                .children
                .splice(offset..offset, moved);
            inserted.extend(valid);
            self.relink(parent);
            if position == "replace" && !ids.contains(target) {
                self.detach(*target);
            }
        }
        inserted
    }
    pub(crate) fn traverse(&self, ids: &[u32], kind: &str) -> Vec<u32> {
        let mut result = Vec::new();
        for id in ids {
            let Some(node) = self.node(*id) else {
                continue;
            };
            match kind {
                "children" => result.extend(
                    node.children
                        .iter()
                        .copied()
                        .filter(|id| self.node(*id).is_some_and(DomNode::is_element)),
                ),
                "contents" => result.extend(node.children.iter().copied()),
                "parent" => result.extend(
                    node.parent
                        .filter(|id| self.node(*id).is_some_and(DomNode::is_element)),
                ),
                "parents" | "ancestors" => {
                    // Like Cheerio, stop at the first document node. A template's
                    // contents live in a fragment, so they never report the
                    // template or its ancestors as their own.
                    let mut parent = node.parent;
                    let mut seen = HashSet::new();
                    while let Some(id) = parent {
                        if !seen.insert(id) {
                            break;
                        }
                        let Some(ancestor) = self.node(id) else {
                            break;
                        };
                        if ancestor.kind == "root" {
                            break;
                        }
                        if ancestor.is_element() {
                            result.push(id);
                        }
                        parent = ancestor.parent;
                    }
                }
                "next" | "prev" | "nextAll" | "prevAll" => {
                    let forward = kind.starts_with("next");
                    let mut next = if forward { node.next } else { node.prev };
                    let mut seen = HashSet::new();
                    while let Some(id) = next {
                        if !seen.insert(id) {
                            break;
                        }
                        if self.node(id).is_some_and(DomNode::is_element) {
                            result.push(id);
                            if kind == "next" || kind == "prev" {
                                break;
                            }
                        }
                        next = self
                            .node(id)
                            .and_then(|node| if forward { node.next } else { node.prev });
                    }
                }
                "siblings" => {
                    if let Some(parent) = node.parent.and_then(|parent| self.node(parent)) {
                        result.extend(parent.children.iter().copied().filter(|other| {
                            other != id && self.node(*other).is_some_and(DomNode::is_element)
                        }));
                    }
                }
                "descendants" => {
                    let mut stack: Vec<_> = node.children.iter().rev().copied().collect();
                    while let Some(id) = stack.pop() {
                        if let Some(node) = self.node(id) {
                            if node.is_element() {
                                result.push(id);
                            }
                            stack.extend(node.children.iter().rev().copied());
                        }
                    }
                }
                _ => {}
            }
        }
        result
    }
    pub(crate) fn set_node(&mut self, id: u32, field: &str, value: &Value) -> Result<()> {
        if self.node(id).is_none() {
            return Ok(());
        }
        if field == "children" {
            self.set_children(id, &value_ids(value));
            return Ok(());
        }
        let node = &mut self.nodes[id as usize];
        match field {
            "name" | "tagName" => node.name = value.as_str().map(str::to_owned),
            "data" | "nodeValue" => node.data = value.as_str().map(str::to_owned),
            "type" => node.kind = node_kind(value.as_str().unwrap_or("tag")),
            "attribs" => node.attribs = value.as_object().cloned().unwrap_or_default().into(),
            "parent" => node.parent = value.as_u64().map(|id| id as u32),
            "prev" => node.prev = value.as_u64().map(|id| id as u32),
            "next" => node.next = value.as_u64().map(|id| id as u32),
            "namespace" => node.namespace = value.as_str().map(namespace_name),
            "attribsNamespace" | "x-attribsNamespace" => {
                node.attribs_namespace = value.as_object().cloned().map(Box::new)
            }
            "attribsPrefix" | "x-attribsPrefix" => {
                node.attribs_prefix = value.as_object().cloned().map(Box::new)
            }
            _ => {
                if value.is_null() {
                    node.extras.remove(field);
                } else {
                    node.extras.insert(field.into(), value.clone());
                }
            }
        }
        Ok(())
    }
}

impl super::selector::SelectDom for DomArena {
    fn kind(&self, id: u32) -> &str {
        self.node(id).map_or("", |node| node.kind.as_ref())
    }
    fn name(&self, id: u32) -> Option<&str> {
        self.node(id)?.name.as_deref()
    }
    fn attr(&self, id: u32, name: &str) -> Option<&str> {
        DomArena::attr(self, id, name)
    }
    fn parent(&self, id: u32) -> Option<u32> {
        self.node(id)?.parent
    }
    fn children(&self, id: u32) -> &[u32] {
        self.node(id).map_or(&[], |node| node.children.as_slice())
    }
    fn text(&self, id: u32) -> String {
        DomArena::text(self, &[id])
    }
    fn xml_mode(&self) -> bool {
        DomArena::xml_mode(self)
    }
    fn lower_case_tags(&self) -> bool {
        self.options
            .get("lowerCaseTags")
            .and_then(Value::as_bool)
            .unwrap_or(!self.xml_mode())
    }
    fn lower_case_attribute_names(&self) -> bool {
        self.options
            .get("lowerCaseAttributeNames")
            .and_then(Value::as_bool)
            .unwrap_or(!self.xml_mode())
    }
    fn custom_pseudo(&self, id: u32, name: &str, arg: Option<&str>) -> Option<bool> {
        let key = format!("{}({})", name, arg.unwrap_or(""));
        self.options
            .get("__pseudoMatches")?
            .get(&key)?
            .as_array()
            .map(|ids| ids.iter().any(|value| value.as_u64() == Some(id as u64)))
    }
    fn pseudo_alias(&self, name: &str) -> Option<&str> {
        self.options.get("pseudos")?.get(name)?.as_str()
    }
    fn elements_named(&self, lowercase_name: &str) -> Option<&[u32]> {
        let index = self.name_index.as_ref()?;
        Some(index.get(lowercase_name).map_or(&[], Vec::as_slice))
    }
    fn is_id_order_document_order(&self) -> bool {
        self.name_index.is_some()
    }
}

pub(crate) fn value_ids(value: &Value) -> Vec<u32> {
    value
        .as_array()
        .map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_u64().map(|id| id as u32))
                .collect()
        })
        .unwrap_or_default()
}
pub(crate) fn xml_mode(options: &Value) -> bool {
    options
        .get("xmlMode")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            options
                .get("xml")
                .is_some_and(|xml| xml.is_object() || xml == &Value::Bool(true))
        })
}
pub(crate) fn normalized_options(mut options: Value) -> Value {
    if !options.is_object() {
        options = json!({});
    }
    if let Some(xml) = options.get("xml").and_then(Value::as_object).cloned() {
        options["xmlMode"] = Value::Bool(true);
        options["_useHtmlParser2"] = Value::Bool(true);
        for (key, value) in xml {
            options[&key] = value;
        }
    } else if options.get("xml") == Some(&Value::Bool(true)) {
        options["xmlMode"] = Value::Bool(true);
        options["_useHtmlParser2"] = Value::Bool(true);
    }
    options
}
fn is_foreign_integration_child(arena: &DomArena, node: &DomNode) -> bool {
    node.parent
        .and_then(|id| arena.node(id))
        .and_then(|parent| parent.name.as_deref())
        .is_some_and(|name| {
            matches!(
                foreign_element_name(name),
                "mi" | "mo"
                    | "mn"
                    | "ms"
                    | "mtext"
                    | "annotation-xml"
                    | "foreignObject"
                    | "desc"
                    | "title"
            )
        })
}
fn foreign_element_name(name: &str) -> &str {
    match name {
        "altglyph" => "altGlyph",
        "altglyphdef" => "altGlyphDef",
        "altglyphitem" => "altGlyphItem",
        "animatecolor" => "animateColor",
        "animatemotion" => "animateMotion",
        "animatetransform" => "animateTransform",
        "clippath" => "clipPath",
        "feblend" => "feBlend",
        "fecolormatrix" => "feColorMatrix",
        "fecomponenttransfer" => "feComponentTransfer",
        "fecomposite" => "feComposite",
        "feconvolvematrix" => "feConvolveMatrix",
        "fediffuselighting" => "feDiffuseLighting",
        "fedisplacementmap" => "feDisplacementMap",
        "fedistantlight" => "feDistantLight",
        "fedropshadow" => "feDropShadow",
        "feflood" => "feFlood",
        "fefunca" => "feFuncA",
        "fefuncb" => "feFuncB",
        "fefuncg" => "feFuncG",
        "fefuncr" => "feFuncR",
        "fegaussianblur" => "feGaussianBlur",
        "feimage" => "feImage",
        "femerge" => "feMerge",
        "femergenode" => "feMergeNode",
        "femorphology" => "feMorphology",
        "feoffset" => "feOffset",
        "fepointlight" => "fePointLight",
        "fespecularlighting" => "feSpecularLighting",
        "fespotlight" => "feSpotLight",
        "fetile" => "feTile",
        "feturbulence" => "feTurbulence",
        "foreignobject" => "foreignObject",
        "glyphref" => "glyphRef",
        "lineargradient" => "linearGradient",
        "radialgradient" => "radialGradient",
        "textpath" => "textPath",
        _ => name,
    }
}
fn foreign_attribute_name(name: &str) -> &str {
    match name {
        "definitionurl" => "definitionURL",
        "attributename" => "attributeName",
        "attributetype" => "attributeType",
        "basefrequency" => "baseFrequency",
        "baseprofile" => "baseProfile",
        "calcmode" => "calcMode",
        "clippathunits" => "clipPathUnits",
        "diffuseconstant" => "diffuseConstant",
        "edgemode" => "edgeMode",
        "filterunits" => "filterUnits",
        "glyphref" => "glyphRef",
        "gradienttransform" => "gradientTransform",
        "gradientunits" => "gradientUnits",
        "kernelmatrix" => "kernelMatrix",
        "kernelunitlength" => "kernelUnitLength",
        "keypoints" => "keyPoints",
        "keysplines" => "keySplines",
        "keytimes" => "keyTimes",
        "lengthadjust" => "lengthAdjust",
        "limitingconeangle" => "limitingConeAngle",
        "markerheight" => "markerHeight",
        "markerunits" => "markerUnits",
        "markerwidth" => "markerWidth",
        "maskcontentunits" => "maskContentUnits",
        "maskunits" => "maskUnits",
        "numoctaves" => "numOctaves",
        "pathlength" => "pathLength",
        "patterncontentunits" => "patternContentUnits",
        "patterntransform" => "patternTransform",
        "patternunits" => "patternUnits",
        "pointsatx" => "pointsAtX",
        "pointsaty" => "pointsAtY",
        "pointsatz" => "pointsAtZ",
        "preservealpha" => "preserveAlpha",
        "preserveaspectratio" => "preserveAspectRatio",
        "primitiveunits" => "primitiveUnits",
        "refx" => "refX",
        "refy" => "refY",
        "repeatcount" => "repeatCount",
        "repeatdur" => "repeatDur",
        "requiredextensions" => "requiredExtensions",
        "requiredfeatures" => "requiredFeatures",
        "specularconstant" => "specularConstant",
        "specularexponent" => "specularExponent",
        "spreadmethod" => "spreadMethod",
        "startoffset" => "startOffset",
        "stddeviation" => "stdDeviation",
        "stitchtiles" => "stitchTiles",
        "surfacescale" => "surfaceScale",
        "systemlanguage" => "systemLanguage",
        "tablevalues" => "tableValues",
        "targetx" => "targetX",
        "targety" => "targetY",
        "textlength" => "textLength",
        "viewbox" => "viewBox",
        "viewtarget" => "viewTarget",
        "xchannelselector" => "xChannelSelector",
        "ychannelselector" => "yChannelSelector",
        "zoomandpan" => "zoomAndPan",
        _ => name,
    }
}
/// entities 1.1 `encodeXML`, as dom-serializer 0.1.x applies it: the five
/// named XML entities, then every non-ASCII scalar as an uppercase hex
/// reference. Astral scalars encode as single combined code points, matching
/// the original surrogate-pair replacer.
fn legacy_escape(value: &str, output: &mut String) {
    use std::fmt::Write;
    for ch in value.chars() {
        match ch {
            '&' => output.push_str("&amp;"),
            '\'' => output.push_str("&apos;"),
            '>' => output.push_str("&gt;"),
            '<' => output.push_str("&lt;"),
            '"' => output.push_str("&quot;"),
            ch if ch > '\u{7f}' => {
                let _ = write!(output, "&#x{:X};", ch as u32);
            }
            ch => output.push(ch),
        }
    }
}

fn escape(value: &str, attribute: bool, xml: bool, utf8: bool, output: &mut String) {
    if xml && !utf8 && crate::codec::has_encoding(value) {
        use std::fmt::Write;
        let units = crate::codec::to_units(value);
        let mut index = 0;
        while index < units.len() {
            let unit = units[index];
            let named = match unit {
                34 => Some("&quot;"),
                38 => Some("&amp;"),
                39 => Some("&apos;"),
                60 => Some("&lt;"),
                62 => Some("&gt;"),
                _ => None,
            };
            if let Some(named) = named {
                output.push_str(named);
                index += 1;
                continue;
            }
            if unit >= 0x80 || unit == 0x24 {
                let high = (0xd800..=0xdbff).contains(&unit);
                let code = if high
                    && units
                        .get(index + 1)
                        .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
                {
                    0x10000 + ((unit as u32 - 0xd800) << 10) + (units[index + 1] as u32 - 0xdc00)
                } else {
                    unit as u32
                };
                let _ = write!(output, "&#x{code:x};");
                // entities.encodeXML advances over a following code unit for
                // every high surrogate, including a lone high surrogate.
                index += if high { 2 } else { 1 };
            } else {
                output.push(char::from_u32(unit as u32).unwrap());
                index += 1;
            }
        }
        return;
    }
    for ch in value.chars() {
        match ch {
            '&' => output.push_str("&amp;"),
            '"' if attribute || xml => output.push_str("&quot;"),
            '\'' if xml => output.push_str("&apos;"),
            '<' if !attribute || xml => output.push_str("&lt;"),
            '>' if !attribute || xml => output.push_str("&gt;"),
            '\u{a0}' if !xml => output.push_str("&nbsp;"),
            ch if xml && !utf8 && (ch > '\u{7f}' || ch == '$') => {
                use std::fmt::Write;
                let _ = write!(output, "&#x{:x};", ch as u32);
            }
            ch => output.push(ch),
        }
    }
}

pub(crate) fn parse_xml(source: &str, options: Value) -> DomArena {
    crate::tokenizer::parse_markup(source, options)
}

/// Incremental htmlparser2/XML input. The complete input is tokenized once, so
/// tags and entities split across chunks parse exactly as one string does.
pub(crate) struct XmlStream {
    pub arena: DomArena,
    pending: String,
}
impl XmlStream {
    pub(crate) fn new(options: Value) -> Self {
        Self {
            arena: DomArena::from_records(vec![DomNode::new("root")], options),
            pending: String::new(),
        }
    }
    pub(crate) fn feed(&mut self, chunk: &str, finish: bool) {
        self.pending.push_str(chunk);
        if finish {
            let options = self.arena.options.clone();
            self.arena = parse_xml(&std::mem::take(&mut self.pending), options);
        }
    }
}
pub(crate) fn append_parsed(
    arena: &mut DomArena,
    parent: u32,
    mut node: DomNode,
    start: usize,
    end: usize,
) -> u32 {
    let (start_indices, end_indices) = *arena.parse_indices.get_or_insert_with(|| {
        (
            arena.options.get("withStartIndices") == Some(&Value::Bool(true)),
            arena.options.get("withEndIndices") == Some(&Value::Bool(true)),
        )
    });
    if node.kind == "text" {
        if let Some(previous) = arena.nodes[parent as usize]
            .children
            .last()
            .copied()
            .filter(|id| arena.nodes[*id as usize].kind == "text")
        {
            arena.nodes[previous as usize]
                .data
                .get_or_insert_with(String::new)
                .push_str(node.data.as_deref().unwrap_or(""));
            if end_indices {
                arena.nodes[previous as usize]
                    .extras
                    .insert("endIndex".into(), json!(end));
            }
            return previous;
        }
    }
    if start_indices {
        node.extras.insert("startIndex".into(), json!(start));
    }
    if end_indices {
        node.extras.insert("endIndex".into(), json!(end));
    }
    let previous = arena.nodes[parent as usize].children.last().copied();
    node.parent = Some(parent);
    node.prev = previous;
    let id = arena.push(node);
    if let Some(previous) = previous {
        arena.nodes[previous as usize].next = Some(id);
    }
    arena.nodes[parent as usize].children.push(id);
    id
}

/// Appends a fresh node of `kind` to `parent` and returns its id. The record
/// is built in the arena itself: moving a whole record through the callers
/// copied it several times per node.
pub(crate) fn append_parsed_new(
    arena: &mut DomArena,
    parent: u32,
    kind: &'static str,
    start: usize,
    end: usize,
) -> u32 {
    let (start_indices, end_indices) = parse_index_flags(arena);
    let previous = arena.nodes[parent as usize].children.last().copied();
    let id = arena.push(DomNode::new(kind));
    let node = &mut arena.nodes[id as usize];
    node.parent = Some(parent);
    node.prev = previous;
    if start_indices {
        node.extras.insert("startIndex".into(), json!(start));
    }
    if end_indices {
        node.extras.insert("endIndex".into(), json!(end));
    }
    if let Some(previous) = previous {
        arena.nodes[previous as usize].next = Some(id);
    }
    arena.nodes[parent as usize].children.push(id);
    id
}

/// Whether parsing records start and end indices, read once per parse.
fn parse_index_flags(arena: &mut DomArena) -> (bool, bool) {
    *arena.parse_indices.get_or_insert_with(|| {
        (
            arena.options.get("withStartIndices") == Some(&Value::Bool(true)),
            arena.options.get("withEndIndices") == Some(&Value::Bool(true)),
        )
    })
}

/// Appends parsed text to `parent`, merging it into a preceding text node.
pub(crate) fn append_parsed_text(
    arena: &mut DomArena,
    parent: u32,
    data: String,
    start: usize,
    end: usize,
) -> u32 {
    let previous_text = arena.nodes[parent as usize]
        .children
        .last()
        .copied()
        .filter(|id| arena.nodes[*id as usize].kind == "text");
    if let Some(previous) = previous_text {
        let (_, end_indices) = parse_index_flags(arena);
        let node = &mut arena.nodes[previous as usize];
        node.data.get_or_insert_with(String::new).push_str(&data);
        if end_indices {
            node.extras.insert("endIndex".into(), json!(end));
        }
        return previous;
    }
    let id = append_parsed_new(arena, parent, "text", start, end);
    arena.nodes[id as usize].data = Some(data);
    id
}

pub(crate) fn html_parser_void(name: &str) -> bool {
    (super::void_name(name) && name != "bgsound") || matches!(name, "command" | "isindex")
}
pub(crate) fn implied_close(name: &str, open: &str) -> bool {
    match name {
        "tr" => matches!(open, "tr" | "th" | "td"),
        "th" => open == "th",
        "td" => matches!(open, "thead" | "th" | "td"),
        "body" => matches!(open, "head" | "link" | "script"),
        "li" => open == "li",
        "option" => open == "option",
        "optgroup" => matches!(open, "option" | "optgroup"),
        "select" | "input" | "output" | "button" | "datalist" | "textarea" => matches!(
            open,
            "input" | "option" | "optgroup" | "select" | "button" | "datalist" | "textarea"
        ),
        "dd" | "dt" => matches!(open, "dd" | "dt"),
        "rt" | "rp" => matches!(open, "rt" | "rp"),
        "tbody" | "tfoot" => matches!(open, "thead" | "tbody"),
        "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "address" | "article" | "aside"
        | "blockquote" | "details" | "div" | "dl" | "fieldset" | "figcaption" | "figure"
        | "footer" | "form" | "header" | "hr" | "main" | "nav" | "ol" | "pre" | "section"
        | "table" | "ul" => open == "p",
        _ => false,
    }
}
pub(crate) fn decode_entities_mode(
    source: &str,
    xml: bool,
    attribute: bool,
    codec: bool,
) -> String {
    let scalar_string = |scalar: char| {
        if codec {
            crate::codec::encode_scalar(scalar)
        } else {
            scalar.to_string()
        }
    };
    let bytes = source.as_bytes();
    let mut output = String::with_capacity(source.len());
    let mut cursor = 0;
    while let Some(relative) = source[cursor..].find('&') {
        let amp = cursor + relative;
        output.push_str(&source[cursor..amp]);
        let mut end = amp + 1;
        let mut decoded = None;
        if bytes.get(end) == Some(&b'#') {
            end += 1;
            let hexadecimal = matches!(bytes.get(end), Some(b'x' | b'X'));
            if hexadecimal {
                end += 1;
            }
            let digits = end;
            let mut number = 0u32;
            while let Some(digit) = bytes
                .get(end)
                .and_then(|value| (*value as char).to_digit(if hexadecimal { 16 } else { 10 }))
            {
                number = number
                    .saturating_mul(if hexadecimal { 16 } else { 10 })
                    .saturating_add(digit);
                end += 1;
            }
            let semicolon = bytes.get(end) == Some(&b';');
            if digits != end && (!xml || semicolon) {
                if semicolon {
                    end += 1;
                }
                let scalar = match number {
                    0 | 0xd800..=0xdfff | 0x110000..=u32::MAX => '\u{fffd}',
                    0x80..=0x9f => html5ever::data::C1_REPLACEMENTS[(number - 0x80) as usize]
                        .unwrap_or(char::from_u32(number).unwrap()),
                    _ => char::from_u32(number).unwrap(),
                };
                decoded = Some(scalar_string(scalar));
            }
        } else {
            while bytes.get(end).is_some_and(u8::is_ascii_alphanumeric) {
                end += 1;
            }
            if bytes.get(end) == Some(&b';') {
                end += 1;
            }
            if xml {
                let scalar = match &source[amp + 1..end] {
                    "amp;" => Some('&'),
                    "lt;" => Some('<'),
                    "gt;" => Some('>'),
                    "quot;" => Some('"'),
                    "apos;" => Some('\''),
                    _ => None,
                };
                decoded = scalar.map(scalar_string);
            } else {
                for candidate in (amp + 2..=end).rev() {
                    if let Some(&(first, second)) =
                        html5ever::data::NAMED_ENTITIES.get(&source[amp + 1..candidate])
                    {
                        if first == 0 {
                            continue;
                        }
                        if bytes[candidate - 1] != b';'
                            && attribute
                            && bytes
                                .get(candidate)
                                .is_some_and(|next| next.is_ascii_alphanumeric() || *next == b'=')
                        {
                            break;
                        }
                        let mut value = scalar_string(char::from_u32(first).unwrap());
                        if second != 0 {
                            value.push_str(&scalar_string(char::from_u32(second).unwrap()));
                        }
                        decoded = Some(value);
                        end = candidate;
                        break;
                    }
                }
            }
        }
        if let Some(value) = decoded {
            output.push_str(&value);
            cursor = end;
        } else {
            output.push('&');
            cursor = amp + 1;
        }
    }
    output.push_str(&source[cursor..]);
    output
}

pub(crate) fn primitive(arena: &mut DomArena, command: &str, args: &Value) -> Result<Value> {
    let ids = value_ids(&args["ids"]);
    let id = args["id"].as_u64().unwrap_or(0) as u32;
    Ok(match command {
        "node" => arena
            .node(id)
            .map(|node| serde_json::to_value(node).unwrap())
            .unwrap_or(Value::Null),
        "createNode" => {
            let mut fields = args.clone();
            if let Some(fields) = fields.as_object_mut() {
                fields.remove("options");
            }
            let mut node: DomNode = serde_json::from_value(fields)
                .map_err(|error| Error::new(Status::InvalidArg, error.to_string()))?;
            node.children.clear();
            node.parent = None;
            node.prev = None;
            node.next = None;
            json!(arena.push(node))
        }
        "setNode" => {
            arena.set_node(id, args["field"].as_str().unwrap_or(""), &args["value"])?;
            Value::Null
        }
        "setAttrs" => {
            // Batched single-attribute writes for one selection: one boundary
            // crossing instead of one per element.
            if let Some(writes) = args.get("writes").and_then(Value::as_array) {
                for write in writes {
                    let id = write
                        .get("id")
                        .and_then(Value::as_u64)
                        .unwrap_or(u32::MAX as u64) as u32;
                    if let Some(node) = arena
                        .node_mut(id)
                        .filter(|node| node.is_element() || node.kind == "root")
                    {
                        if let Some(attrs) = write.get("attrs").and_then(Value::as_array) {
                            for attr in attrs {
                                let name = attr.get("name").and_then(Value::as_str).unwrap_or("");
                                if name.is_empty() {
                                    continue;
                                }
                                match attr.get("value") {
                                    Some(Value::Null) | None => {
                                        node.attribs.shift_remove(name);
                                    }
                                    Some(value) => {
                                        node.attribs.insert(name.to_string(), value.clone());
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Value::Null
        }
        "attrs" => {
            if let Some(value) = args.get("value") {
                arena.set_node(id, "attribs", value)?;
                Value::Null
            } else {
                Value::Object(
                    arena
                        .node(id)
                        .map(|node| node.attribs.to_map())
                        .unwrap_or_default(),
                )
            }
        }
        "attr" => {
            let name = args["name"].as_str().unwrap_or("");
            if let Some(value) = args.get("value") {
                let value = value
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| (!value.is_null()).then(|| value.to_string()));
                arena.set_attr(&ids, name, value.as_deref());
                Value::Null
            } else {
                ids.first()
                    .and_then(|id| arena.attr(*id, name))
                    .map(|value| json!(value))
                    .unwrap_or(Value::Null)
            }
        }
        "text" => {
            if let Some(value) = args.get("value") {
                arena.set_text(&ids, value.as_str().unwrap_or(""));
                Value::Null
            } else {
                json!(arena.text(&ids))
            }
        }
        "html" => {
            if let Some(value) = args.get("value") {
                arena.set_html(&ids, value.as_str().unwrap_or(""))?;
                Value::Null
            } else {
                ids.first()
                    .map(|id| json!(arena.inner_html_mut(*id)))
                    .unwrap_or(Value::Null)
            }
        }
        "outerHtml" | "render" => {
            let mut options = arena.options.clone();
            if let Some(overrides) = args.get("options").and_then(Value::as_object) {
                for (key, value) in overrides {
                    options[key] = value.clone();
                }
            }
            json!(arena.serialize_mut(&ids, &normalized_options(options)))
        }
        "traverse" => json!(arena.traverse(&ids, args["kind"].as_str().unwrap_or("children"))),
        "select" | "matches" => {
            let previous = arena
                .options
                .as_object_mut()
                .and_then(|options| options.remove("__pseudoMatches"));
            if let Some(matches) = args.get("pseudoMatches") {
                arena.options["__pseudoMatches"] = matches.clone();
            }
            let result = if command == "select" {
                super::selector::select(
                    arena,
                    args["selector"].as_str().unwrap_or(""),
                    args.get("contexts").map(value_ids).as_deref(),
                )
            } else {
                super::selector::filter(arena, args["selector"].as_str().unwrap_or(""), &ids)
            };
            arena
                .options
                .as_object_mut()
                .unwrap()
                .remove("__pseudoMatches");
            if let Some(previous) = previous {
                arena.options["__pseudoMatches"] = previous;
            }
            json!(result?)
        }
        "create" => json!(arena.create_fragment(
            args["html"].as_str().unwrap_or(""),
            args["contextId"].as_u64().map(|id| id as u32)
        )?),
        "import" => {
            let records: Vec<DomNode> = serde_json::from_value(args["nodes"].clone())
                .map_err(|error| Error::new(Status::InvalidArg, error.to_string()))?;
            json!(arena.import(&records, &value_ids(&args["roots"])))
        }
        "clone" => json!(arena.clone_ids(&ids, args["deep"].as_bool().unwrap_or(true))),
        "insert" => json!(arena.insert(
            &value_ids(&args["targetIds"]),
            &value_ids(&args["nodeIds"]),
            args["position"].as_str().unwrap_or("append")
        )),
        "remove" => {
            if args["keepChildren"].as_bool() == Some(true) {
                for id in &ids {
                    let children = arena
                        .node(*id)
                        .map(|node| node.children.clone())
                        .unwrap_or_default();
                    arena.insert(&[*id], &children, "before");
                    arena.detach(*id);
                }
            } else {
                arena.detach_many(&ids);
            }
            Value::Null
        }
        "uniqueSort" => json!(crate::document_order::unique_sort(&*arena, &ids)),
        "contains" => {
            let parent = args
                .get("container")
                .or_else(|| args.get("parent"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32;
            let mut node = args
                .get("contained")
                .or_else(|| args.get("child"))
                .and_then(Value::as_u64)
                .map(|id| id as u32);
            let mut found = false;
            let mut seen = HashSet::new();
            while let Some(id) = node {
                if !seen.insert(id) {
                    break;
                }
                node = arena.node(id).and_then(|node| node.parent);
                if node == Some(parent) {
                    found = true;
                    break;
                }
            }
            json!(found)
        }
        _ => {
            return Err(Error::new(
                Status::InvalidArg,
                format!("Unknown native DOM command {command}"),
            ))
        }
    })
}
