//! Fill the HTML5 integration-point hook omitted by scraper's tree sink.

use std::borrow::Cow;
use std::cell::{Ref, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use ego_tree::NodeId;
use html5ever::tendril::StrTendril;
use html5ever::tree_builder::{ElementFlags, NodeOrText, QuirksMode, TreeSink};
use html5ever::{Attribute, QualName};
use scraper::{Html, HtmlTreeSink};

pub(crate) struct CompatibleSink(
    HtmlTreeSink,
    Option<RefCell<Vec<Cow<'static, str>>>>,
    Option<Rc<crate::tracker::Locations<NodeId>>>,
);

impl CompatibleSink {
    pub(crate) fn new(html: Html) -> Self {
        Self(HtmlTreeSink::new(html), None, None)
    }
    pub(crate) fn with_errors(html: Html) -> Self {
        Self(
            HtmlTreeSink::new(html),
            Some(RefCell::new(Vec::new())),
            None,
        )
    }
    pub(crate) fn with_locations(
        html: Html,
        locations: Rc<crate::tracker::Locations<NodeId>>,
    ) -> Self {
        Self(HtmlTreeSink::new(html), None, Some(locations))
    }
    fn element(&self, name: QualName, attrs: Vec<Attribute>, flags: ElementFlags) -> NodeId {
        let local = name.local.to_string();
        let id = self.0.create_element(name, attrs, flags);
        if let Some(locations) = &self.2 {
            locations.created(id, &local);
        }
        id
    }
    pub(crate) fn take_errors(&self) -> Vec<Cow<'static, str>> {
        self.1
            .as_ref()
            .map(|errors| std::mem::take(&mut *errors.borrow_mut()))
            .unwrap_or_default()
    }
}

impl TreeSink for CompatibleSink {
    type Handle = NodeId;
    type Output = Html;
    type ElemName<'a> = Ref<'a, QualName>;

    fn finish(self) -> Html {
        self.0.finish()
    }

    fn parse_error(&self, message: Cow<'static, str>) {
        if let Some(errors) = &self.1 {
            errors.borrow_mut().push(message.clone());
        }
        self.0.parse_error(message);
    }

    fn get_document(&self) -> NodeId {
        self.0.get_document()
    }

    fn elem_name<'a>(&'a self, target: &'a NodeId) -> Ref<'a, QualName> {
        self.0.elem_name(target)
    }

    fn create_element(&self, name: QualName, attrs: Vec<Attribute>, flags: ElementFlags) -> NodeId {
        if attrs.len() < 2 || name.ns.as_ref() == super::HTML_NS {
            return self.element(name, attrs, flags);
        }
        // parse5's htmlparser2 adapter keys attributes by local name. Keep the
        // first insertion position and the last value/namespace when foreign
        // attributes such as href and xlink:href have the same local name.
        let mut positions = HashMap::new();
        let mut collapsed = Vec::with_capacity(attrs.len());
        for attr in attrs {
            if let Some(position) = positions.get(&attr.name.local) {
                collapsed[*position] = attr;
            } else {
                positions.insert(attr.name.local.clone(), collapsed.len());
                collapsed.push(attr);
            }
        }
        self.element(name, collapsed, flags)
    }

    fn create_comment(&self, text: StrTendril) -> NodeId {
        let id = self.0.create_comment(text);
        if let Some(locations) = &self.2 {
            locations.token(id, "comment");
        }
        id
    }

    fn create_pi(&self, target: StrTendril, data: StrTendril) -> NodeId {
        self.0.create_pi(target, data)
    }

    fn append(&self, parent: &NodeId, child: NodeOrText<NodeId>) {
        let text = match &child {
            NodeOrText::AppendText(text) => Some(text.to_string()),
            _ => None,
        };
        self.0.append(parent, child);
        if let (Some(locations), Some(text)) = (&self.2, text) {
            if let Some(id) = self
                .0
                 .0
                .borrow()
                .tree
                .get(*parent)
                .and_then(|node| node.last_child())
                .filter(|node| node.value().is_text())
                .map(|node| node.id())
            {
                locations.text(id, &text);
            }
        }
    }

    fn append_based_on_parent_node(
        &self,
        element: &NodeId,
        previous: &NodeId,
        child: NodeOrText<NodeId>,
    ) {
        if self
            .0
             .0
            .borrow()
            .tree
            .get(*element)
            .and_then(|node| node.parent())
            .is_some()
        {
            self.append_before_sibling(element, child);
        } else {
            self.append(previous, child);
        }
    }

    fn append_doctype_to_document(
        &self,
        name: StrTendril,
        public_id: StrTendril,
        system_id: StrTendril,
    ) {
        self.0
            .append_doctype_to_document(name, public_id, system_id);
        if let Some(locations) = &self.2 {
            if let Some(id) = self
                .0
                 .0
                .borrow()
                .tree
                .root()
                .children()
                .find(|node| matches!(node.value(), scraper::Node::Doctype(_)))
                .map(|node| node.id())
            {
                locations.token(id, "doctype");
            }
        }
    }

    fn get_template_contents(&self, target: &NodeId) -> NodeId {
        self.0.get_template_contents(target)
    }

    fn on_stack_pop(&self, node: &NodeId, _current: Option<&NodeId>) {
        if let Some(locations) = &self.2 {
            locations.closed(*node);
        }
    }

    fn same_node(&self, first: &NodeId, second: &NodeId) -> bool {
        self.0.same_node(first, second)
    }

    fn set_quirks_mode(&self, mode: QuirksMode) {
        self.0.set_quirks_mode(mode);
    }

    fn append_before_sibling(&self, sibling: &NodeId, new_node: NodeOrText<NodeId>) {
        let text = match &new_node {
            NodeOrText::AppendText(text) => Some(text.to_string()),
            _ => None,
        };
        self.0.append_before_sibling(sibling, new_node);
        if let (Some(locations), Some(text)) = (&self.2, text) {
            if let Some(id) = self
                .0
                 .0
                .borrow()
                .tree
                .get(*sibling)
                .and_then(|node| node.prev_sibling())
                .filter(|node| node.value().is_text())
                .map(|node| node.id())
            {
                locations.text(id, &text);
            }
        }
    }

    fn add_attrs_if_missing(&self, target: &NodeId, attrs: Vec<Attribute>) {
        let mut existing: HashSet<_> = self
            .0
             .0
            .borrow()
            .tree
            .get(*target)
            .and_then(|node| node.value().as_element())
            .map(|element| {
                element
                    .attrs
                    .iter()
                    .map(|(name, _)| name.local.clone())
                    .collect()
            })
            .unwrap_or_default();
        let attrs = attrs
            .into_iter()
            .filter(|attr| existing.insert(attr.name.local.clone()))
            .collect();
        self.0.add_attrs_if_missing(target, attrs);
    }

    fn remove_from_parent(&self, target: &NodeId) {
        self.0.remove_from_parent(target);
    }

    fn reparent_children(&self, node: &NodeId, new_parent: &NodeId) {
        // scraper reparents with ego_tree's `reparent_from_id_append`, which
        // only points the first and last moved child at their new parent;
        // the adoption agency algorithm then loses nodes moved later.
        let mut html = self.0 .0.borrow_mut();
        let children: Vec<NodeId> = html
            .tree
            .get(*node)
            .map(|parent| parent.children().map(|child| child.id()).collect())
            .unwrap_or_default();
        if let Some(mut parent) = html.tree.get_mut(*new_parent) {
            for child in children {
                parent.append_id(child);
            }
        }
    }

    fn is_mathml_annotation_xml_integration_point(&self, handle: &NodeId) -> bool {
        let html = self.0 .0.borrow();
        html.tree
            .get(*handle)
            .and_then(|node| node.value().as_element())
            .is_some_and(|element| {
                element.name.ns.as_ref() == "http://www.w3.org/1998/Math/MathML"
                    && element.name() == "annotation-xml"
                    && element.attr("encoding").is_some_and(|encoding| {
                        encoding.eq_ignore_ascii_case("text/html")
                            || encoding.eq_ignore_ascii_case("application/xhtml+xml")
                    })
            })
    }
}
