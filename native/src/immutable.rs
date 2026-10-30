//! Read-only selection over a parsed document. Queries, matching and ordering
//! run on the parse tree, so a document is copied into the mutable arena only
//! when it is first changed.
use ego_tree::iter::Edge;
use ego_tree::NodeId;
use scraper::{Html, Node};
use serde_json::Value;

use crate::selector::SelectDom;

const NONE: u32 = u32::MAX;

/// Parent and child links by local id. Local ids are preorder positions, so
/// ascending order is document order.
pub(crate) struct TreeIndex {
    parent: Vec<u32>,
    child_start: Vec<u32>,
    child_end: Vec<u32>,
    children: Vec<u32>,
}

impl TreeIndex {
    pub(crate) fn build(html: &Html, count: usize) -> Self {
        let mut parent = vec![NONE; count];
        let mut stack: Vec<u32> = Vec::new();
        let mut next = 0u32;
        for edge in html.tree.root().traverse() {
            match edge {
                Edge::Open(_) => {
                    if (next as usize) < count {
                        parent[next as usize] = stack.last().copied().unwrap_or(NONE);
                    }
                    stack.push(next);
                    next += 1;
                }
                Edge::Close(_) => {
                    stack.pop();
                }
            }
        }
        let mut counts = vec![0u32; count];
        for parent in &parent {
            if let Some(slot) = counts.get_mut(*parent as usize) {
                *slot += 1;
            }
        }
        let mut total = 0u32;
        let child_start: Vec<u32> = counts
            .iter()
            .map(|count| {
                let start = total;
                total += count;
                start
            })
            .collect();
        let mut child_end = child_start.clone();
        let mut children = vec![0u32; total as usize];
        for (local, parent) in parent.iter().enumerate() {
            if let Some(end) = child_end.get_mut(*parent as usize) {
                children[*end as usize] = local as u32;
                *end += 1;
            }
        }
        Self {
            parent,
            child_start,
            child_end,
            children,
        }
    }

    /// The index of a tree some of whose nodes were detached after parsing,
    /// when traversal order no longer matches local ids.
    pub(crate) fn build_mapped(
        html: &Html,
        ids: &[NodeId],
        reverse: &crate::id_hash::IdMap<NodeId, u32>,
    ) -> Self {
        let local = |node: Option<ego_tree::NodeRef<'_, Node>>| {
            node.and_then(|node| reverse.get(&node.id()).copied())
        };
        let mut parent = vec![NONE; ids.len()];
        let mut child_start = vec![0u32; ids.len()];
        let mut child_end = vec![0u32; ids.len()];
        let mut children = Vec::with_capacity(ids.len());
        for (index, id) in ids.iter().enumerate() {
            let Some(node) = html.tree.get(*id) else {
                continue;
            };
            parent[index] = local(node.parent()).unwrap_or(NONE);
            child_start[index] = children.len() as u32;
            children.extend(node.children().filter_map(|child| local(Some(child))));
            child_end[index] = children.len() as u32;
        }
        Self {
            parent,
            child_start,
            child_end,
            children,
        }
    }

    pub(crate) fn parent(&self, id: u32) -> Option<u32> {
        self.parent
            .get(id as usize)
            .copied()
            .filter(|parent| *parent != NONE)
    }

    pub(crate) fn children(&self, id: u32) -> &[u32] {
        match (
            self.child_start.get(id as usize),
            self.child_end.get(id as usize),
        ) {
            (Some(start), Some(end)) => &self.children[*start as usize..*end as usize],
            _ => &[],
        }
    }

    /// Whether `ancestor` is a proper ancestor of `id`.
    pub(crate) fn contains(&self, ancestor: u32, id: u32) -> bool {
        let mut current = self.parent(id);
        while let Some(node) = current {
            if node == ancestor {
                return true;
            }
            current = self.parent(node);
        }
        false
    }
}

/// The parse tree seen through the same interface as the mutable arena.
pub(crate) struct TreeDom<'a> {
    pub html: &'a Html,
    pub ids: &'a [NodeId],
    pub index: &'a TreeIndex,
    pub options: &'a Value,
}

impl TreeDom<'_> {
    fn node(&self, id: u32) -> Option<ego_tree::NodeRef<'_, Node>> {
        self.html.tree.get(*self.ids.get(id as usize)?)
    }

    /// The value the arena would hold: attributes are keyed by local name and
    /// a repeated local name keeps its last value.
    pub(crate) fn element_attr(&self, id: u32, name: &str) -> Option<&str> {
        match self.node(id)?.value() {
            Node::Element(element) => element
                .attrs
                .iter()
                .rev()
                .find(|(key, _)| key.local.as_ref() == name)
                .map(|(_, value)| value.as_ref()),
            _ => None,
        }
    }

    pub(crate) fn is_element(&self, id: u32) -> bool {
        matches!(
            self.node(id).map(|node| node.value()),
            Some(Node::Element(_))
        )
    }
}

impl SelectDom for TreeDom<'_> {
    fn kind(&self, id: u32) -> &str {
        match self.node(id).map(|node| node.value()) {
            Some(Node::Element(element)) => match element.name() {
                "script" => "script",
                "style" => "style",
                _ => "tag",
            },
            Some(Node::Text(_)) => "text",
            Some(Node::Comment(_)) => "comment",
            Some(Node::Doctype(_) | Node::ProcessingInstruction(_)) => "directive",
            Some(Node::Document | Node::Fragment) => "root",
            None => "",
        }
    }
    fn name(&self, id: u32) -> Option<&str> {
        match self.node(id)?.value() {
            Node::Element(element) => Some(element.name()),
            Node::Doctype(_) => Some("!doctype"),
            Node::ProcessingInstruction(instruction) => Some(&instruction.target),
            _ => None,
        }
    }
    fn attr(&self, id: u32, name: &str) -> Option<&str> {
        self.element_attr(id, name)
    }
    fn parent(&self, id: u32) -> Option<u32> {
        self.index.parent(id)
    }
    fn children(&self, id: u32) -> &[u32] {
        self.index.children(id)
    }
    fn text(&self, id: u32) -> String {
        let mut output = String::new();
        let mut stack = vec![id];
        while let Some(id) = stack.pop() {
            match self.node(id).map(|node| node.value()) {
                Some(Node::Text(text)) => output.push_str(text),
                Some(_) => stack.extend(self.index.children(id).iter().rev().copied()),
                None => {}
            }
        }
        output
    }
    fn xml_mode(&self) -> bool {
        crate::arena::xml_mode(self.options)
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
}

/// Whether a class attribute contains `needle` as a whitespace-separated token,
/// exactly as the arena's `hasClass` reads it.
pub(crate) fn has_class_token(classes: &str, needle: &str) -> bool {
    !needle.is_empty()
        && classes.match_indices(needle).any(|(index, _)| {
            (index == 0
                || classes[..index]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace))
                && (index + needle.len() == classes.len()
                    || classes[index + needle.len()..]
                        .chars()
                        .next()
                        .is_some_and(char::is_whitespace))
        })
}
