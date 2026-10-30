//! An active user-supplied tree adapter. Rust runs the HTML5 algorithm; the
//! adapter supplies every construction, mutation and tree-inspection decision.
use std::borrow::Cow;
use std::cell::{Cell, Ref, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use html5ever::tendril::{StrTendril, TendrilSink};
use html5ever::tree_builder::{ElementFlags, NodeOrText, QuirksMode, TreeSink};
use html5ever::{Attribute, LocalName, Namespace, QualName};
use napi::{Env, Error, JsFunction, JsString, Result, Status};
use serde_json::{json, Value};

use crate::arena::{DomArena, DomNode};
use crate::NativeDocument;

// HTML5 token identities used by the parser, independent of adapter DOM names.
fn known_html_tag(name: &str) -> bool {
    matches!(
        name,
        "a" | "address"
            | "annotation-xml"
            | "applet"
            | "area"
            | "article"
            | "aside"
            | "b"
            | "base"
            | "basefont"
            | "bgsound"
            | "big"
            | "blockquote"
            | "body"
            | "br"
            | "button"
            | "caption"
            | "center"
            | "code"
            | "col"
            | "colgroup"
            | "dd"
            | "desc"
            | "details"
            | "dialog"
            | "dir"
            | "div"
            | "dl"
            | "dt"
            | "em"
            | "embed"
            | "fieldset"
            | "figcaption"
            | "figure"
            | "font"
            | "footer"
            | "foreignObject"
            | "form"
            | "frame"
            | "frameset"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "head"
            | "header"
            | "hgroup"
            | "hr"
            | "html"
            | "i"
            | "img"
            | "image"
            | "input"
            | "iframe"
            | "keygen"
            | "label"
            | "li"
            | "link"
            | "listing"
            | "main"
            | "malignmark"
            | "marquee"
            | "math"
            | "menu"
            | "meta"
            | "mglyph"
            | "mi"
            | "mo"
            | "mn"
            | "ms"
            | "mtext"
            | "nav"
            | "nobr"
            | "noframes"
            | "noembed"
            | "noscript"
            | "object"
            | "ol"
            | "optgroup"
            | "option"
            | "p"
            | "param"
            | "plaintext"
            | "pre"
            | "rb"
            | "rp"
            | "rt"
            | "rtc"
            | "ruby"
            | "s"
            | "script"
            | "search"
            | "section"
            | "select"
            | "source"
            | "small"
            | "span"
            | "strike"
            | "strong"
            | "style"
            | "sub"
            | "summary"
            | "sup"
            | "table"
            | "tbody"
            | "template"
            | "textarea"
            | "tfoot"
            | "td"
            | "th"
            | "thead"
            | "title"
            | "tr"
            | "track"
            | "tt"
            | "u"
            | "ul"
            | "svg"
            | "var"
            | "wbr"
            | "xmp"
    )
}

struct DirectBridge {
    env: Env,
    function: napi::Ref<()>,
}
impl DirectBridge {
    fn call(&self, request: &str) -> Result<Value> {
        let function: JsFunction = self.env.get_reference_value(&self.function)?;
        let argument = self.env.create_string(request)?;
        let result = function.call(None, &[argument])?;
        let text: JsString = result.coerce_to_string()?;
        serde_json::from_str(text.into_utf8()?.as_str()?)
            .map_err(|error| Error::new(Status::InvalidArg, error.to_string()))
    }
}
impl Drop for DirectBridge {
    fn drop(&mut self) {
        let _ = self.function.unref(self.env);
    }
}

pub(crate) type HookCall = Box<dyn Fn(&str, Value) -> Result<Value>>;

enum Transport {
    Direct(DirectBridge),
    Threaded(HookCall),
}
impl Transport {
    fn call(&self, method: &str, args: Value) -> Result<Value> {
        let result = match self {
            Self::Direct(bridge) => bridge.call(&json!({"method":method,"args":args}).to_string()),
            Self::Threaded(bridge) => bridge(method, args),
        }?;
        if result.get("__cheeroxHookError").and_then(Value::as_bool) == Some(true) {
            Err(Error::new(
                Status::GenericFailure,
                "User treeAdapter hook failed",
            ))
        } else {
            Ok(result)
        }
    }
}

struct HookSink {
    bridge: Transport,
    names: RefCell<HashMap<u32, QualName>>,
    error: RefCell<Option<Error>>,
    options: Value,
    fragment: bool,
    source: String,
    context: Option<Rc<crate::diagnostics::DiagnosticContext>>,
    diagnostics: RefCell<Vec<Value>>,
    locations: Option<crate::tracker::Locations<u32>>,
    pending_escape: Cell<Option<TextTarget>>,
}

/// Where a text chunk is inserted: appended to `parent`, or before `sibling`.
#[derive(Clone, Copy, PartialEq, Eq)]
struct TextTarget {
    parent: u32,
    sibling: Option<u32>,
}

/// Whether the final character is a codec escape whose character has not
/// arrived yet. Escapes pair with the following character.
fn ends_with_unpaired_escape(text: &str) -> bool {
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch == crate::codec::ESCAPE && chars.next().is_none() {
            return true;
        }
    }
    false
}

impl HookSink {
    fn call(&self, method: &str, args: Value) -> Value {
        if self.error.borrow().is_some() {
            return Value::Null;
        }
        if matches!(
            method,
            "appendChild"
                | "insertBefore"
                | "detachNode"
                | "setDocumentType"
                | "setTemplateContent"
                | "__snapshot"
        ) {
            self.flush_escape();
        }
        let result = self.bridge.call(method, args);
        match result {
            Ok(value) => value,
            Err(error) => {
                *self.error.borrow_mut() = Some(error);
                Value::Null
            }
        }
    }
    fn node(&self, method: &str, args: Value) -> u32 {
        self.call(method, args).as_u64().unwrap_or(0) as u32
    }
    /// The tokenizer may split a codec escape from its character across text
    /// chunks. Adapters decode each chunk separately, so a trailing escape is
    /// held until the next chunk for the same target.
    fn insert_text(&self, target: TextTarget, text: &str) {
        let mut data = String::with_capacity(text.len() + crate::codec::ESCAPE.len_utf8());
        if let Some(pending) = self.pending_escape.take() {
            if pending == target {
                data.push(crate::codec::ESCAPE);
            } else {
                self.send_text(pending, &crate::codec::ESCAPE.to_string());
            }
        }
        data.push_str(text);
        if ends_with_unpaired_escape(&data) {
            data.pop();
            self.pending_escape.set(Some(target));
        }
        if !data.is_empty() {
            self.send_text(target, &data);
        }
    }
    fn send_text(&self, target: TextTarget, data: &str) {
        match target.sibling {
            None => self.call("insertText", json!([target.parent, data])),
            Some(sibling) => self.call("insertTextBefore", json!([target.parent, data, sibling])),
        };
    }
    fn flush_escape(&self) {
        if let Some(pending) = self.pending_escape.take() {
            self.send_text(pending, &crate::codec::ESCAPE.to_string());
        }
    }
    fn attrs(attrs: Vec<Attribute>) -> Value {
        Value::Array(
            attrs
                .into_iter()
                .map(|attr| {
                    let mut value =
                        json!({"name":attr.name.local.as_ref(),"value":attr.value.as_ref()});
                    if !attr.name.ns.as_ref().is_empty() {
                        value["prefix"] = Value::String(
                            attr.name
                                .prefix
                                .as_ref()
                                .map_or("", |prefix| prefix.as_ref())
                                .into(),
                        );
                        value["namespace"] = Value::String(attr.name.ns.as_ref().into());
                    }
                    value
                })
                .collect(),
        )
    }
    fn publish_location(&self, id: u32, update: bool) {
        let Some(location) = self
            .locations
            .as_ref()
            .and_then(|locations| locations.get(id))
        else {
            return;
        };
        if update {
            if let Some(fields) = location.as_object() {
                let patch: serde_json::Map<String, Value> =
                    ["endLine", "endCol", "endOffset", "endTag"]
                        .into_iter()
                        .filter_map(|field| {
                            fields
                                .get(field)
                                .map(|value| (field.to_owned(), value.clone()))
                        })
                        .collect();
                if !patch.is_empty() {
                    self.call("updateNodeSourceCodeLocation", json!([id, patch]));
                }
            }
        } else {
            let mut location = location;
            if let Some(fields) = location.as_object_mut() {
                let start_tag = fields.get("startTag").cloned();
                if let Some(start_tag) = start_tag {
                    for field in ["endLine", "endCol", "endOffset"] {
                        if !fields.contains_key(field) {
                            fields.insert(field.to_owned(), start_tag[field].clone());
                        }
                    }
                }
            }
            self.call("setNodeSourceCodeLocation", json!([id, location]));
        }
    }
    fn mark_text(&self, parent: u32, before: Option<u32>, data: &str) {
        let children = self.children(parent);
        let id = match before {
            Some(before) => children
                .iter()
                .position(|id| *id == before)
                .and_then(|index| index.checked_sub(1))
                .and_then(|index| children.get(index))
                .copied(),
            None => children.last().copied(),
        };
        if let (Some(locations), Some(id)) = (self.locations.as_ref(), id) {
            let existing = self.call("getNodeSourceCodeLocation", json!([id]));
            locations.text(id, data);
            self.publish_location(id, !existing.is_null());
        }
    }
    fn children(&self, id: u32) -> Vec<u32> {
        self.call("getChildNodes", json!([id]))
            .as_array()
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| id.as_u64().map(|id| id as u32))
                    .collect()
            })
            .unwrap_or_default()
    }
}

impl TreeSink for HookSink {
    type Handle = u32;
    type Output = Result<NativeDocument>;
    type ElemName<'a> = Ref<'a, QualName>;

    fn finish(self) -> Self::Output {
        if self.fragment {
            // html5ever exposes a synthetic html element for fragments. The
            // adapter sees the same fragment root shape as Cheerio's parser.
            for child in self.children(0) {
                if self.call("isElementNode", json!([child])).as_bool() == Some(true)
                    && self.call("getTagName", json!([child])).as_str() == Some("html")
                {
                    for node in self.children(child) {
                        self.call("detachNode", json!([node]));
                        self.call("appendChild", json!([0, node]));
                    }
                    self.call("detachNode", json!([child]));
                    break;
                }
            }
        }
        let snapshot = self.call("__snapshot", json!([]));
        if let Some(error) = self.error.borrow_mut().take() {
            return Err(error);
        }
        let mut records: Vec<DomNode> = serde_json::from_value(snapshot).map_err(|error| {
            Error::new(
                Status::InvalidArg,
                format!("Invalid treeAdapter DOM: {error}"),
            )
        })?;
        let source = if self.source.is_empty() {
            self.context
                .as_ref()
                .map(|context| context.source_between(0, context.source_len()))
                .unwrap_or_default()
        } else {
            self.source.clone()
        };
        if self.options.get("sourceCodeLocationInfo") == Some(&Value::Bool(true))
            && !source.is_empty()
        {
            let mut fallback = records.clone();
            crate::location::annotate(
                &source,
                &mut fallback,
                self.options.get("scriptingEnabled") != Some(&Value::Bool(false)),
                self.options.get("__utf16Codec") == Some(&Value::Bool(true)),
            );
            // Explicit creation/text/close operations published locations live.
            // Only deferred table text or adapter-internal nodes lack them.
            let locations: Vec<_> = records
                .iter()
                .zip(&fallback)
                .filter(|(node, _)| {
                    !node.extras.contains_key("sourceCodeLocation") && node.kind != "root"
                })
                .filter_map(|(node, fallback)| {
                    fallback
                        .extras
                        .get("sourceCodeLocation")
                        .map(|location| json!({"id":node.id,"location":location}))
                })
                .collect();
            self.call("__locations", json!([locations]));
            let snapshot = self.call("__snapshot", json!([]));
            if let Some(error) = self.error.borrow_mut().take() {
                return Err(error);
            }
            records = serde_json::from_value(snapshot)
                .map_err(|error| Error::new(Status::InvalidArg, error.to_string()))?;
        }
        let options = self.options;
        let document =
            NativeDocument::from_arena(DomArena::from_records(records, options.clone()), options);
        document.set_diagnostic_records(self.diagnostics.into_inner());
        Ok(document)
    }
    fn parse_error(&self, message: Cow<'static, str>) {
        if let Some(error) = self
            .context
            .as_ref()
            .and_then(|context| context.error(&message))
        {
            self.diagnostics.borrow_mut().push(error.clone());
            self.call("__parseError", json!([error]));
        }
    }
    fn get_document(&self) -> u32 {
        0
    }
    fn elem_name<'a>(&'a self, target: &'a u32) -> Ref<'a, QualName> {
        let namespace = self
            .call("getNamespaceURI", json!([target]))
            .as_str()
            .unwrap_or(crate::HTML_NS)
            .to_owned();
        let original = self.names.borrow().get(target).cloned();
        // parse5 records known HTML token IDs on its open-element stack. A
        // user adapter can rename the resulting DOM element without changing
        // how a later known closing tag addresses that parser stack entry.
        let local = if namespace == crate::HTML_NS
            && original
                .as_ref()
                .is_some_and(|name| known_html_tag(name.local.as_ref()))
        {
            original.unwrap().local.to_string()
        } else {
            self.call("getTagName", json!([target]))
                .as_str()
                .unwrap_or("unknown")
                .to_owned()
        };
        self.names.borrow_mut().insert(
            *target,
            QualName::new(None, Namespace::from(namespace), LocalName::from(local)),
        );
        Ref::map(self.names.borrow(), |names| &names[target])
    }
    fn create_element(&self, name: QualName, attrs: Vec<Attribute>, flags: ElementFlags) -> u32 {
        let id = self.node(
            "createElement",
            json!([name.local.as_ref(), name.ns.as_ref(), Self::attrs(attrs)]),
        );
        if let Some(locations) = self.locations.as_ref() {
            locations.created(id, name.local.as_ref());
            self.publish_location(id, false);
        }
        self.names.borrow_mut().insert(id, name);
        if flags.template {
            let content = self.node("createDocumentFragment", json!([]));
            self.call("setTemplateContent", json!([id, content]));
        }
        id
    }
    fn create_comment(&self, text: StrTendril) -> u32 {
        let id = self.node("createCommentNode", json!([text.as_ref()]));
        if let Some(locations) = self.locations.as_ref() {
            locations.token(id, "comment");
        }
        id
    }
    fn create_pi(&self, target: StrTendril, data: StrTendril) -> u32 {
        self.create_comment(format!("?{target} {data}?").into())
    }
    fn append(&self, parent: &u32, child: NodeOrText<u32>) {
        match child {
            NodeOrText::AppendNode(child) => {
                self.call("appendChild", json!([parent, child]));
                if self
                    .context
                    .as_ref()
                    .is_some_and(|context| context.current_token().kind == "comment")
                {
                    self.publish_location(child, false);
                }
            }
            NodeOrText::AppendText(text) => {
                let target = TextTarget {
                    parent: *parent,
                    sibling: None,
                };
                self.insert_text(target, text.as_ref());
                self.mark_text(*parent, None, text.as_ref());
            }
        }
    }
    fn append_based_on_parent_node(&self, element: &u32, previous: &u32, child: NodeOrText<u32>) {
        if self.call("getParentNode", json!([element])).is_null() {
            self.append(previous, child);
        } else {
            self.append_before_sibling(element, child);
        }
    }
    fn append_doctype_to_document(
        &self,
        name: StrTendril,
        public_id: StrTendril,
        system_id: StrTendril,
    ) {
        self.call(
            "setDocumentType",
            json!([0, name.as_ref(), public_id.as_ref(), system_id.as_ref()]),
        );
        if let Some(locations) = self.locations.as_ref() {
            for id in self.children(0) {
                if self.call("isDocumentTypeNode", json!([id])).as_bool() == Some(true) {
                    locations.token(id, "doctype");
                    self.publish_location(id, false);
                    break;
                }
            }
        }
    }
    fn get_template_contents(&self, target: &u32) -> u32 {
        self.node("getTemplateContent", json!([target]))
    }
    fn same_node(&self, first: &u32, second: &u32) -> bool {
        first == second
    }
    fn pop(&self, node: &u32) {
        if let Some(locations) = self.locations.as_ref() {
            let name = self.call("getTagName", json!([node]));
            locations.closed_as(*node, name.as_str().unwrap_or(""));
            self.publish_location(*node, true);
        }
    }
    fn on_stack_push(&self, node: &u32) {
        self.call("onItemPush", json!([node]));
    }
    fn on_stack_pop(&self, node: &u32, current: Option<&u32>) {
        self.call("onItemPop", json!([node, current]));
    }
    fn set_quirks_mode(&self, mode: QuirksMode) {
        let mode = match mode {
            QuirksMode::Quirks => "quirks",
            QuirksMode::LimitedQuirks => "limited-quirks",
            QuirksMode::NoQuirks => "no-quirks",
        };
        self.call("setDocumentMode", json!([0, mode]));
    }
    fn append_before_sibling(&self, sibling: &u32, new_node: NodeOrText<u32>) {
        let parent = self.node("getParentNode", json!([sibling]));
        match new_node {
            NodeOrText::AppendNode(node) => {
                self.call("detachNode", json!([node]));
                self.call("insertBefore", json!([parent, node, sibling]));
            }
            NodeOrText::AppendText(text) => {
                let target = TextTarget {
                    parent,
                    sibling: Some(*sibling),
                };
                self.insert_text(target, text.as_ref());
                self.mark_text(parent, Some(*sibling), text.as_ref());
            }
        }
    }
    fn add_attrs_if_missing(&self, target: &u32, attrs: Vec<Attribute>) {
        self.call("adoptAttributes", json!([target, Self::attrs(attrs)]));
    }
    fn remove_from_parent(&self, target: &u32) {
        self.call("detachNode", json!([target]));
    }
    fn reparent_children(&self, node: &u32, new_parent: &u32) {
        for child in self.children(*node) {
            self.call("detachNode", json!([child]));
            self.call("appendChild", json!([new_parent, child]));
        }
    }
    fn is_mathml_annotation_xml_integration_point(&self, handle: &u32) -> bool {
        let namespace = self.call("getNamespaceURI", json!([handle]));
        let name = self.call("getTagName", json!([handle]));
        namespace.as_str() == Some("http://www.w3.org/1998/Math/MathML")
            && name.as_str() == Some("annotation-xml")
            && self
                .call("getAttrList", json!([handle]))
                .as_array()
                .is_some_and(|attrs| {
                    attrs.iter().any(|attr| {
                        attr["name"] == "encoding"
                            && attr["value"].as_str().is_some_and(|value| {
                                value.eq_ignore_ascii_case("text/html")
                                    || value.eq_ignore_ascii_case("application/xhtml+xml")
                            })
                    })
                })
    }
}

fn parser(
    env: Env,
    is_document: bool,
    options_json: String,
    bridge: JsFunction,
) -> Result<html5ever::Parser<HookSink>> {
    let options: Value = serde_json::from_str(&options_json)
        .map_err(|error| Error::new(Status::InvalidArg, error.to_string()))?;
    let bridge = DirectBridge {
        env,
        function: env.create_reference(bridge)?,
    };
    let sink = HookSink {
        bridge: Transport::Direct(bridge),
        names: RefCell::new(HashMap::new()),
        error: RefCell::new(None),
        options: options.clone(),
        fragment: !is_document,
        source: String::new(),
        context: None,
        diagnostics: RefCell::new(Vec::new()),
        locations: None,
        pending_escape: Cell::new(None),
    };
    sink.call(
        if is_document {
            "createDocument"
        } else {
            "createDocumentFragment"
        },
        json!([]),
    );
    let parse_options = html5ever::driver::ParseOpts {
        tokenizer: html5ever::tokenizer::TokenizerOpts {
            discard_bom: false,
            cheerox_codec: options.get("__utf16Codec") == Some(&Value::Bool(true)),
            ..Default::default()
        },
        tree_builder: html5ever::tree_builder::TreeBuilderOpts {
            scripting_enabled: options.get("scriptingEnabled") != Some(&Value::Bool(false)),
            ..Default::default()
        },
    };
    Ok(if is_document {
        html5ever::driver::parse_document(sink, parse_options)
    } else {
        let context = QualName::new(
            None,
            Namespace::from(
                options
                    .get("__contextNamespace")
                    .and_then(Value::as_str)
                    .unwrap_or(crate::HTML_NS),
            ),
            LocalName::from(
                options
                    .get("__contextName")
                    .and_then(Value::as_str)
                    .unwrap_or("template"),
            ),
        );
        html5ever::driver::parse_fragment(sink, parse_options, context, Vec::new(), false)
    })
}

pub(crate) fn parse(
    env: Env,
    source: String,
    is_document: bool,
    options_json: String,
    bridge: JsFunction,
) -> Result<NativeDocument> {
    let options: Value = serde_json::from_str(&options_json)
        .map_err(|error| Error::new(Status::InvalidArg, error.to_string()))?;
    if options.get("__collectParseErrors") == Some(&Value::Bool(true))
        || options.get("sourceCodeLocationInfo") == Some(&Value::Bool(true))
    {
        let context = Rc::new(crate::diagnostics::DiagnosticContext::new(&source));
        let bridge = DirectBridge {
            env,
            function: env.create_reference(bridge)?,
        };
        let sink = HookSink {
            bridge: Transport::Direct(bridge),
            names: RefCell::new(HashMap::new()),
            error: RefCell::new(None),
            options: options.clone(),
            fragment: !is_document,
            source: source.clone(),
            context: Some(context.clone()),
            diagnostics: RefCell::new(Vec::new()),
            locations: (options.get("sourceCodeLocationInfo") == Some(&Value::Bool(true)))
                .then(|| crate::tracker::Locations::new(context.clone())),
            pending_escape: Cell::new(None),
        };
        sink.call(
            if is_document {
                "createDocument"
            } else {
                "createDocumentFragment"
            },
            json!([]),
        );
        crate::diagnostics::parse_with_sink(
            &source,
            is_document,
            &options,
            sink,
            context,
            |_, _| {},
        )
    } else {
        let mut parser = parser(env, is_document, options_json, bridge)?;
        parser.tokenizer.sink.sink.source.push_str(&source);
        parser.one(source)
    }
}

/// A blocking reader is driven on a native worker. The supplied transport waits
/// for a main-thread JS callback response for every actual sink operation.
pub(crate) fn parse_reader<R: html5gum::Reader>(
    reader: R,
    options: Value,
    is_document: bool,
    context: Rc<crate::diagnostics::DiagnosticContext>,
    call: HookCall,
) -> Result<NativeDocument>
where
    R::Error: std::fmt::Display,
{
    let sink = HookSink {
        bridge: Transport::Threaded(call),
        names: RefCell::new(HashMap::new()),
        error: RefCell::new(None),
        options: options.clone(),
        fragment: !is_document,
        source: String::new(),
        context: Some(context.clone()),
        diagnostics: RefCell::new(Vec::new()),
        locations: (options.get("sourceCodeLocationInfo") == Some(&Value::Bool(true)))
            .then(|| crate::tracker::Locations::new(context.clone())),
        pending_escape: Cell::new(None),
    };
    sink.call(
        if is_document {
            "createDocument"
        } else {
            "createDocumentFragment"
        },
        json!([]),
    );
    crate::diagnostics::parse_reader_with_sink(
        reader,
        is_document,
        &options,
        sink,
        context,
        |_, _| {},
    )
    .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?
}
