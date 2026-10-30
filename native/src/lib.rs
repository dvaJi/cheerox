//! Immutable HTML5 documents, exposed to Node.js through Node-API.
//!
//! Parsing and extraction tasks own their input and output. In particular, no
//! JavaScript value or borrowed DOM crosses into the libuv or Rayon workers.

use std::borrow::Cow;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};

use ego_tree::{NodeId, NodeRef};
use html5ever::tendril::TendrilSink;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use scraper::{Html, Node, Selector};
use serde_json::{Map, Value};

use codec::JsText;

#[cfg(target_os = "linux")]
#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

mod arena;
mod attributes;
mod codec;
mod diagnostics;
mod document_order;
mod extraction;
mod gc;
mod hook_sink;
mod hook_stream;
mod id_hash;
mod immutable;
mod location;
mod markup_tokenizer;
mod runtime;
mod selector;
mod sink;
mod snapshot;
mod stream;
mod tokenizer;
mod tracker;

pub use hook_stream::NativeHookStream;
pub use runtime::{configure_worker_pool, worker_pool_info, WorkerPoolInfo};
pub use stream::NativeStream;

const HTML_NS: &str = "http://www.w3.org/1999/xhtml";
const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS: &str = "http://www.w3.org/2000/xmlns/";
const XLINK_NS: &str = "http://www.w3.org/1999/xlink";

/// Writes an attribute's serialized name. Like parse5, the namespace rather
/// than the stored prefix selects the qualifier: HTML5 gives foreign `xmlns`
/// attributes an empty prefix, which must not become `:xmlns`. Other namespaces
/// keep a non-empty prefix; an empty or missing one writes the bare name.
pub(crate) fn push_attribute_name(
    output: &mut String,
    local: &str,
    namespace: Option<&str>,
    prefix: Option<&str>,
) {
    match namespace.filter(|namespace| !namespace.is_empty()) {
        None => {}
        Some(XML_NS) => output.push_str("xml:"),
        Some(XMLNS_NS) => {
            if local != "xmlns" {
                output.push_str("xmlns:");
            }
        }
        Some(XLINK_NS) => output.push_str("xlink:"),
        Some(_) => {
            if let Some(prefix) = prefix.filter(|prefix| !prefix.is_empty()) {
                output.push_str(prefix);
                output.push(':');
            }
        }
    }
    output.push_str(local);
}

/// Orders attributes the way a JavaScript object enumerates its keys: integer
/// keys first, ascending, then insertion order. Cheerio serializes attributes
/// from such an object.
pub(crate) fn js_property_order<'a, T, I>(entries: I) -> JsPropertyOrder<I>
where
    I: Iterator<Item = (&'a str, T)> + Clone,
{
    if !entries.clone().any(|(name, _)| array_index(name).is_some()) {
        return JsPropertyOrder::Unchanged(entries);
    }
    let mut keyed: Vec<_> = entries
        .map(|entry| {
            (
                array_index(entry.0).map_or((1, 0), |index| (0, index)),
                entry,
            )
        })
        .collect();
    keyed.sort_by_key(|(key, _)| *key);
    let sorted: Vec<_> = keyed.into_iter().map(|(_, entry)| entry).collect();
    JsPropertyOrder::Sorted(sorted.into_iter())
}

pub(crate) enum JsPropertyOrder<I: Iterator> {
    Unchanged(I),
    Sorted(std::vec::IntoIter<I::Item>),
}

impl<I: Iterator> Iterator for JsPropertyOrder<I> {
    type Item = I::Item;
    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::Unchanged(entries) => entries.next(),
            Self::Sorted(entries) => entries.next(),
        }
    }
}

fn array_index(name: &str) -> Option<u32> {
    let is_canonical = !name.is_empty()
        && name.len() <= 10
        && name.bytes().all(|byte| byte.is_ascii_digit())
        && (name == "0" || !name.starts_with('0'));
    is_canonical
        .then(|| name.parse::<u64>().ok())
        .flatten()
        .filter(|value| *value < u64::from(u32::MAX))
        .map(|value| value as u32)
}

#[napi(custom_finalize)]
pub struct NativeDocument {
    html: RefCell<Option<Html>>,
    // Stable public IDs are preorder positions, rather than parser allocation
    // positions: HTML5 foster parenting can change the latter's ordering.
    ids: RefCell<Vec<NodeId>>,
    reverse: RefCell<id_hash::IdMap<NodeId, u32>>,
    /// Parent/child links of the parse tree, built on the first query that needs them.
    tree_index: RefCell<Option<immutable::TreeIndex>>,
    pub(crate) arena: RefCell<Option<arena::DomArena>>,
    options: Value,
    source: RefCell<Option<String>>,
    retained: RefCell<HashMap<u32, usize>>,
    needs_collect: Cell<bool>,
    managed: Cell<bool>,
    /// Slots managed collections keep regardless of pins.
    kept_slots: Cell<u32>,
    /// The document index JavaScript routes this document's node ids by.
    routing_index: Cell<Option<u32>>,
    /// Nodes were removed from the parse tree, so traversal order no longer
    /// matches local ids and parsed nodes may be orphans.
    tree_detached: Cell<bool>,
    /// Parents whose children a parse-tree removal changed since JavaScript last asked.
    tree_touched: RefCell<Vec<u32>>,
    _live: LiveDocument,
    diagnostics: RefCell<Vec<Value>>,
    locations: RefCell<HashMap<u32, Value>>,
    // V8 cannot see native allocations. Reporting them lets its GC collect
    // unreachable documents under native memory pressure.
    content_bytes: Cell<usize>,
    reported_heap_bytes: Cell<i64>,
    /// Results of extraction plans run on the parsing thread, in request
    /// order, until JavaScript takes them.
    prepared_plans: RefCell<Option<Vec<Option<String>>>>,
    /// A snapshot built on the parsing thread, until JavaScript takes it.
    prepared_snapshot: RefCell<Option<snapshot::NodeSnapshot>>,
}

/// Node-API calls the finalizers of a module that declares the experimental
/// version directly from garbage collection, rather than on a later turn of
/// the event loop, so a synchronous loop over documents frees each native tree
/// as soon as V8 collects its document. Finalizers must therefore not call
/// into V8: see `NativeDocument::finalize`.
#[no_mangle]
pub extern "C" fn node_api_module_get_api_version_v1() -> i32 {
    NAPI_VERSION_EXPERIMENTAL
}

const NAPI_VERSION_EXPERIMENTAL: i32 = i32::MAX;

thread_local! {
    /// External memory of finalized documents not yet returned to V8.
    static RELEASED_HEAP_BYTES: Cell<i64> = const { Cell::new(0) };
    /// Routing indexes of finalized documents, free for new documents.
    static FREE_ROUTING_INDEXES: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
    static NEXT_ROUTING_INDEX: Cell<u32> = const { Cell::new(0) };
}

static LIVE_DOCUMENTS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Counts documents whose native storage has not been dropped yet.
struct LiveDocument;

impl LiveDocument {
    fn new() -> Self {
        LIVE_DOCUMENTS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Self
    }
}

impl Drop for LiveDocument {
    fn drop(&mut self) {
        LIVE_DOCUMENTS.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Trees with more nodes than this are freed on the shared pool, so a
/// collection pause does not wait for them.
const POOL_RELEASE_NODES: usize = 4096;

impl ObjectFinalize for NativeDocument {
    fn finalize(self, _env: Env) -> Result<()> {
        // Adjusting external memory during garbage collection is not allowed;
        // the next report on this thread returns it.
        let reported = self.reported_heap_bytes.get();
        RELEASED_HEAP_BYTES.with(|released| released.set(released.get() + reported));
        if let Some(index) = self.routing_index.get() {
            FREE_ROUTING_INDEXES.with(|free| free.borrow_mut().push(index));
        }
        let nodes = self.ids.borrow().len()
            + self
                .arena
                .borrow()
                .as_ref()
                .map_or(0, |arena| arena.nodes.len());
        if nodes > POOL_RELEASE_NODES {
            runtime::release_later((
                self.html.into_inner(),
                self.arena.into_inner(),
                self.ids.into_inner(),
                self.reverse.into_inner(),
                self.tree_index.into_inner(),
            ));
        }
        Ok(())
    }
}

fn html_node_content_bytes(node: &Node) -> usize {
    match node {
        Node::Text(text) => text.len(),
        Node::Comment(comment) => comment.len(),
        Node::Element(element) => element.attrs.iter().map(|(_, value)| value.len()).sum(),
        _ => 0,
    }
}

/// Approximate retained bytes per node in each representation, excluding the
/// text and attribute content counted separately. V8 treats the total only as
/// allocation pressure, so these err on the high side.
const IMMUTABLE_NODE_BYTES: usize = 256;
const ARENA_NODE_BYTES: usize = 512;
/// Smaller changes to an already reported size are skipped to keep operations cheap.
const HEAP_REPORT_STEP: i64 = 64 * 1024;

impl NativeDocument {
    pub(crate) fn from_arena(arena: arena::DomArena, options: Value) -> Self {
        let content_bytes = arena.nodes.iter().map(arena::DomNode::content_bytes).sum();
        Self::from_arena_sized(arena, options, content_bytes)
    }

    /// A document over `arena` whose text and attribute content takes about
    /// `content_bytes`, such as the length of the source it was parsed from.
    fn from_arena_sized(arena: arena::DomArena, options: Value, content_bytes: usize) -> Self {
        if arena.nodes.len() > POOL_RELEASE_NODES {
            runtime::start_release_thread();
        }
        runtime::return_parse_pages(arena.nodes.len());
        Self {
            html: RefCell::new(None),
            ids: RefCell::new(Vec::new()),
            reverse: RefCell::new(id_hash::IdMap::default()),
            tree_index: RefCell::new(None),
            arena: RefCell::new(Some(arena)),
            options,
            source: RefCell::new(None),
            retained: RefCell::new(HashMap::new()),
            needs_collect: Cell::new(false),
            managed: Cell::new(false),
            kept_slots: Cell::new(0),
            routing_index: Cell::new(None),
            tree_detached: Cell::new(false),
            tree_touched: RefCell::new(Vec::new()),
            _live: LiveDocument::new(),
            diagnostics: RefCell::new(Vec::new()),
            locations: RefCell::new(HashMap::new()),
            content_bytes: Cell::new(content_bytes),
            reported_heap_bytes: Cell::new(0),
            prepared_plans: RefCell::new(None),
            prepared_snapshot: RefCell::new(None),
        }
    }
    pub(crate) fn set_diagnostic_records(&self, records: Vec<Value>) {
        *self.diagnostics.borrow_mut() = records;
    }
    fn maybe_collect(&self) {
        if self.needs_collect.get() {
            self.collect_garbage();
        }
    }
    #[cfg(test)]
    fn parse(source: &str, is_document: bool) -> Self {
        Self::parse_options(source, is_document, serde_json::json!({}), None)
    }

    fn estimated_heap_bytes(&self) -> i64 {
        let live_arena_nodes = self.arena.borrow().as_ref().map_or(0, |arena| {
            arena.nodes.len().saturating_sub(arena.free.len())
        });
        let immutable_nodes = self.ids.borrow().len();
        let retained_source = self.source.borrow().as_ref().map_or(0, String::capacity);
        let content = if live_arena_nodes + immutable_nodes == 0 {
            0
        } else {
            self.content_bytes.get()
        };
        let bytes = content
            + retained_source
            + immutable_nodes * IMMUTABLE_NODE_BYTES
            + live_arena_nodes * ARENA_NODE_BYTES;
        i64::try_from(bytes).unwrap_or(i64::MAX)
    }

    fn report_heap_bytes(&self, mut env: Env) {
        let released = RELEASED_HEAP_BYTES.with(|released| released.replace(0));
        if released != 0 && env.adjust_external_memory(-released).is_err() {
            RELEASED_HEAP_BYTES.with(|pending| pending.set(pending.get() + released));
        }
        let reported = self.reported_heap_bytes.get();
        let estimated = self.estimated_heap_bytes();
        let change = estimated - reported;
        let is_small_update = reported != 0 && estimated != 0 && change.abs() < HEAP_REPORT_STEP;
        if change != 0 && !is_small_update && env.adjust_external_memory(change).is_ok() {
            self.reported_heap_bytes.set(estimated);
        }
    }

    fn reported<T>(&self, env: Env, value: T) -> T {
        self.report_heap_bytes(env);
        value
    }

    pub(crate) fn parse_options(
        source: &str,
        is_document: bool,
        parser_options: Value,
        context_name: Option<&str>,
    ) -> Self {
        let mut parser_options = arena::normalized_options(parser_options);
        if codec::has_encoding(source) {
            parser_options["__losslessUnicode"] = Value::Bool(true);
        }
        if let Some(events) = parser_options
            .as_object_mut()
            .and_then(|options| options.remove("__tokenEvents"))
        {
            return Self::from_arena_sized(
                tokenizer::parse(source, &events, parser_options.clone()),
                parser_options,
                source.len(),
            );
        }
        if arena::xml_mode(&parser_options)
            || parser_options.get("_useHtmlParser2") == Some(&Value::Bool(true))
        {
            return Self::from_arena_sized(
                arena::parse_xml(source, parser_options.clone()),
                parser_options,
                source.len(),
            );
        }

        let capture = parser_options
            .get("sourceCodeLocationInfo")
            .is_some_and(|value| !matches!(value, Value::Null | Value::Bool(false)))
            || parser_options.get("__collectParseErrors") == Some(&Value::Bool(true));
        // HTML5 input preprocessing turns CRLF and CR into LF; html5ever does
        // it one character at a time, which dominates pages with CRLF endings.
        // Captured source locations must index the original input instead.
        let normalized;
        let source = if !capture && source.contains('\r') {
            normalized = normalize_newlines(source);
            normalized.as_str()
        } else {
            source
        };
        if !is_document && context_name.is_none() && !capture && is_plain_text(source) {
            return Self::from_html(plain_text_fragment(source), false, parser_options, None);
        }

        let options = html5ever::driver::ParseOpts {
            tokenizer: html5ever::tokenizer::TokenizerOpts {
                discard_bom: false,
                rusteerio_codec: parser_options.get("__utf16Codec") == Some(&Value::Bool(true)),
                ..Default::default()
            },
            tree_builder: html5ever::tree_builder::TreeBuilderOpts {
                scripting_enabled: parser_options.get("scriptingEnabled")
                    != Some(&Value::Bool(false)),
                ..Default::default()
            },
        };
        let html = if is_document {
            html5ever::driver::parse_document(
                sink::CompatibleSink::new(sized_html(source, true)),
                options,
            )
            .one(source)
        } else {
            // parse5's default fragment context is a template. A body context
            // discards valid standalone table fragments such as <td> and <tr>.
            html5ever::driver::parse_fragment(
                sink::CompatibleSink::new(sized_html(source, false)),
                options,
                html5ever::QualName::new(
                    None,
                    html5ever::Namespace::from(
                        parser_options
                            .get("__contextNamespace")
                            .and_then(Value::as_str)
                            .unwrap_or(HTML_NS),
                    ),
                    html5ever::LocalName::from(context_name.unwrap_or("template")),
                ),
                Vec::new(),
                false,
            )
            .one(source)
        };

        Self::from_html(
            html,
            is_document,
            parser_options,
            capture.then(|| source.to_string()),
        )
    }

    pub(crate) fn from_html(
        mut html: Html,
        is_document: bool,
        parser_options: Value,
        source: Option<String>,
    ) -> Self {
        if !is_document {
            unwrap_fragment_root(&mut html);
        }

        let mut locations = HashMap::new();
        if parser_options.get("sourceCodeLocationInfo") == Some(&Value::Bool(true)) {
            if let Some(source) = source.as_ref() {
                let context = std::rc::Rc::new(diagnostics::DiagnosticContext::new(source));
                let tracker = std::rc::Rc::new(tracker::Locations::new(context.clone()));
                let mut tracked = diagnostics::parse_with_sink(
                    source,
                    is_document,
                    &parser_options,
                    sink::CompatibleSink::with_locations(
                        if is_document {
                            Html::new_document()
                        } else {
                            Html::new_fragment()
                        },
                        tracker.clone(),
                    ),
                    context,
                    |_, _| {},
                );
                if !is_document {
                    unwrap_fragment_root(&mut tracked);
                }
                let order: HashMap<_, _> = tracked
                    .tree
                    .root()
                    .descendants()
                    .enumerate()
                    .map(|(index, node)| (node.id(), index as u32))
                    .collect();
                locations = tracker
                    .take()
                    .into_iter()
                    .filter_map(|(id, value)| order.get(&id).map(|id| (*id, value)))
                    .collect();
            }
        }

        let ids: Vec<_> = html
            .tree
            .root()
            .descendants()
            .map(|node| node.id())
            .collect();
        let reverse = ids
            .iter()
            .enumerate()
            .map(|(index, id)| (*id, index as u32))
            .collect();
        let diagnostics = if parser_options.get("__collectParseErrors") == Some(&Value::Bool(true))
        {
            source
                .as_ref()
                .map(|source| diagnostics::collect(source, is_document, &parser_options))
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let source = parser_options
            .get("sourceCodeLocationInfo")
            .filter(|value| {
                !matches!(value, Value::Null | Value::Bool(false))
                    && value != &&serde_json::json!(0)
                    && value != &&serde_json::json!("")
            })
            .and(source);
        let content_bytes = html.tree.values().map(html_node_content_bytes).sum();
        if ids.len() > POOL_RELEASE_NODES {
            runtime::start_release_thread();
        }
        runtime::return_parse_pages(ids.len());
        Self {
            html: RefCell::new(Some(html)),
            ids: RefCell::new(ids),
            reverse: RefCell::new(reverse),
            tree_index: RefCell::new(None),
            arena: RefCell::new(None),
            options: parser_options,
            source: RefCell::new(source),
            retained: RefCell::new(HashMap::new()),
            needs_collect: Cell::new(false),
            managed: Cell::new(false),
            kept_slots: Cell::new(0),
            routing_index: Cell::new(None),
            tree_detached: Cell::new(false),
            tree_touched: RefCell::new(Vec::new()),
            _live: LiveDocument::new(),
            diagnostics: RefCell::new(diagnostics),
            locations: RefCell::new(locations),
            content_bytes: Cell::new(content_bytes),
            reported_heap_bytes: Cell::new(0),
            prepared_plans: RefCell::new(None),
            prepared_snapshot: RefCell::new(None),
        }
    }

    /// The arena borrowed for writing. It drops the name index first: a write
    /// may add, remove or reorder elements.
    pub(crate) fn arena_for_write(&self) -> std::cell::RefMut<'_, Option<arena::DomArena>> {
        let mut arena = self.arena.borrow_mut();
        if let Some(arena) = arena.as_mut() {
            arena.name_index = None;
        }
        arena
    }

    /// The arena borrowed for a write that changes only attributes or data,
    /// which keeps the name index valid.
    pub(crate) fn arena_for_attribute_write(
        &self,
    ) -> std::cell::RefMut<'_, Option<arena::DomArena>> {
        self.arena.borrow_mut()
    }

    pub(crate) fn ensure_arena(&self) -> Result<()> {
        let missing = self.arena.borrow().is_none();
        if missing {
            let records = {
                let html = self.html.borrow();
                let ids = self.ids.borrow();
                let reverse = self.reverse.borrow();
                let tree = SharedTree {
                    html: html
                        .as_ref()
                        .ok_or_else(|| Error::new(Status::GenericFailure, "Missing parse tree"))?,
                    ids: &ids,
                    reverse: &reverse,
                };
                runtime::chunked_map(ids.len(), CONVERSION_CHUNK, |range| tree.convert(range))
            };
            let mut arena = arena::DomArena::from_linked_records(records, self.options.clone());
            if let Some(source) = self.source.borrow().as_ref() {
                location::annotate(
                    source,
                    &mut arena.nodes,
                    self.options.get("scriptingEnabled") != Some(&Value::Bool(false)),
                    self.options.get("__utf16Codec") == Some(&Value::Bool(true)),
                );
            }
            for (id, patch) in std::mem::take(&mut *self.locations.borrow_mut()) {
                if let Some(node) = arena.nodes.get_mut(id as usize) {
                    if let Value::Object(patch) = patch {
                        let existing = node
                            .extras
                            .entry("sourceCodeLocation")
                            .or_insert_with(|| serde_json::json!({}));
                        if !existing.is_object() {
                            *existing = serde_json::json!({});
                        }
                        existing.as_object_mut().unwrap().extend(patch);
                    } else {
                        node.extras.insert("sourceCodeLocation".into(), patch);
                    }
                }
            }
            *self.arena.borrow_mut() = Some(arena);
            let html = self.html.borrow_mut().take();
            let reverse = std::mem::take(&mut *self.reverse.borrow_mut());
            let ids = std::mem::take(&mut *self.ids.borrow_mut());
            // Freeing a large parse tree takes as long as copying it; the
            // JavaScript thread need not wait for it. Waking a worker costs
            // more than freeing a small one.
            if ids.len() > POOL_RELEASE_NODES {
                runtime::release_later((html, reverse, ids));
            }
            self.source.borrow_mut().take();
            *self.tree_index.borrow_mut() = None;
        }
        Ok(())
    }

    fn with_node<T>(
        &self,
        id: u32,
        operation: impl FnOnce(NodeRef<'_, Node>, &Html) -> T,
    ) -> Option<T> {
        let html = self.html.borrow();
        let html = html.as_ref()?;
        let node = html.tree.get(*self.ids.borrow().get(id as usize)?)?;
        Some(operation(node, html))
    }

    /// Runs `operation` over the parse tree, or returns `None` once the
    /// document has moved to the mutable arena.
    fn with_tree_dom<T>(
        &self,
        options: &Value,
        operation: impl FnOnce(&immutable::TreeDom<'_>) -> T,
    ) -> Option<T> {
        if self.arena.borrow().is_some() {
            return None;
        }
        let html = self.html.borrow();
        let html = html.as_ref()?;
        let ids = self.ids.borrow();
        if self.tree_index.borrow().is_none() {
            let index = if self.tree_detached.get() {
                immutable::TreeIndex::build_mapped(html, &ids, &self.reverse.borrow())
            } else {
                immutable::TreeIndex::build(html, ids.len())
            };
            *self.tree_index.borrow_mut() = Some(index);
        }
        let index = self.tree_index.borrow();
        let dom = immutable::TreeDom {
            html,
            ids: &ids,
            index: index.as_ref()?,
            options,
        };
        Some(operation(&dom))
    }

    fn immutable_dom_node(&self, id: u32) -> Option<arena::DomNode> {
        let html = self.html.borrow();
        let ids = self.ids.borrow();
        let reverse = self.reverse.borrow();
        convert_node(html.as_ref()?, &ids, &reverse, id)
    }

    fn immutable_record(&self, id: u32) -> Option<Value> {
        serde_json::to_value(self.immutable_dom_node(id)?).ok()
    }

    /// Read commands answered from the parse tree; `None` when the command
    /// needs the mutable arena.
    fn tree_read(
        &self,
        command: &str,
        args: &Value,
        ids: &[u32],
        options: &Value,
    ) -> Option<Result<Value>> {
        match command {
            "select" | "matches" => {
                let mut options = options.clone();
                if let Some(matches) = args.get("pseudoMatches") {
                    options["__pseudoMatches"] = matches.clone();
                }
                let selector = args["selector"].as_str().unwrap_or("");
                let contexts = args.get("contexts").map(arena::value_ids);
                self.with_tree_dom(&options, |dom| {
                    if command == "select" {
                        selector::select(dom, selector, contexts.as_deref())
                    } else {
                        selector::filter(dom, selector, ids)
                    }
                    .map(|ids| serde_json::json!(ids))
                })
            }
            "uniqueSort" => {
                // Removed nodes have no place in the parse tree's order, so
                // the arena orders them.
                if self.tree_detached.get() {
                    return None;
                }
                self.with_tree_dom(options, |dom| {
                    if !document_order::is_document_ordered(dom, ids) {
                        return Ok(serde_json::json!(document_order::unique_sort(dom, ids)));
                    }
                    // Local ids of a parse tree are preorder positions: document order.
                    let mut unique = ids.to_vec();
                    unique.sort_unstable();
                    unique.dedup();
                    Ok(serde_json::json!(unique))
                })
            }
            "hasClass" => {
                let needle = args["name"].as_str().unwrap_or("");
                self.with_tree_dom(options, |dom| {
                    Ok(Value::Bool(ids.iter().any(|id| {
                        dom.is_element(*id)
                            && dom
                                .element_attr(*id, "class")
                                .is_some_and(|classes| immutable::has_class_token(classes, needle))
                    })))
                })
            }
            "contains" => {
                let container = args
                    .get("container")
                    .or_else(|| args.get("parent"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as u32;
                let contained = args
                    .get("contained")
                    .or_else(|| args.get("child"))
                    .and_then(Value::as_u64)? as u32;
                self.with_tree_dom(options, |dom| {
                    Ok(Value::Bool(dom.index.contains(container, contained)))
                })
            }
            "extractPlan" => Some(extraction::execute_in(self, &args["plan"], ids)),
            _ => None,
        }
    }

    /// A node with only the kind, name and attributes the attribute commands read.
    fn attribute_node(&self, id: u32) -> Option<arena::DomNode> {
        self.with_node(id, |node, _| {
            let mut record = arena::DomNode::new("text");
            if let Node::Element(element) = node.value() {
                record.kind = match element.name() {
                    "script" => "script",
                    "style" => "style",
                    _ => "tag",
                }
                .into();
                record.name = Some(element.name().into());
                if !element.attrs.is_empty() {
                    record.attribs = arena::Attributes::with_capacity(element.attrs.len());
                }
                for (name, value) in &element.attrs {
                    record
                        .attribs
                        .insert(name.local.to_string(), Value::String(value.to_string()));
                }
            }
            record
        })
    }

    /// Applies a write that only changes attributes to the parse tree, so the
    /// document is not copied into the mutable arena. The arena's own attribute
    /// logic runs on a temporary arena holding just the target elements.
    fn tree_attribute_write(
        &self,
        command: &str,
        args: &Value,
        ids: &[u32],
        options: &Value,
    ) -> Option<Result<Value>> {
        let is_write = match command {
            "attr" | "css" => args.get("value").is_some(),
            "removeAttr" | "addClass" | "removeClass" | "toggleClass" => true,
            _ => false,
        };
        if !is_write || self.source.borrow().is_some() {
            return None;
        }
        let mut targets: Vec<u32> = Vec::new();
        for id in ids {
            if !targets.contains(id) {
                targets.push(*id);
            }
        }
        let nodes: Vec<arena::DomNode> = targets
            .iter()
            .map(|id| self.attribute_node(*id))
            .collect::<Option<_>>()?;
        let before: Vec<arena::Attributes> =
            nodes.iter().map(|node| node.attribs.clone()).collect();
        let mut scratch = arena::DomArena::from_records(nodes, options.clone());
        if self.options.get("__utf16Codec") == Some(&Value::Bool(true)) {
            scratch.options["__utf16Codec"] = Value::Bool(true);
        }
        let mut local_args = args.clone();
        local_args["ids"] = serde_json::json!(ids
            .iter()
            .map(|id| targets.iter().position(|target| target == id).unwrap_or(0))
            .collect::<Vec<_>>());
        let result = match attributes::execute(&mut scratch, command, &local_args) {
            Ok(Some(result)) => result,
            Ok(None) => return None,
            Err(error) => return Some(Err(error)),
        };
        let mut html = self.html.borrow_mut();
        let html = html.as_mut()?;
        let node_ids = self.ids.borrow();
        for (index, id) in targets.iter().enumerate() {
            let after = &scratch.nodes[index].attribs;
            if *after == before[index] {
                continue;
            }
            let mut node = html.tree.get_mut(*node_ids.get(*id as usize)?)?;
            let Node::Element(element) = node.value() else {
                continue;
            };
            let attributes = after
                .iter()
                .map(|(name, value)| {
                    let qualified = element
                        .attrs
                        .keys()
                        .rev()
                        .find(|key| key.local.as_ref() == name)
                        .cloned()
                        .unwrap_or_else(|| {
                            html5ever::QualName::new(
                                None,
                                html5ever::ns!(),
                                html5ever::LocalName::from(name.as_str()),
                            )
                        });
                    let value = value
                        .as_str()
                        .map_or_else(|| value.to_string(), str::to_owned);
                    html5ever::Attribute {
                        name: qualified,
                        value: value.into(),
                    }
                })
                .collect();
            *element = scraper::node::Element::new(element.name.clone(), attributes);
        }
        Some(Ok(result))
    }

    /// Cheerio-compatible selection without copying an unchanged document.
    fn select_native(&self, source: &str, contexts: Option<&[u32]>) -> Result<Vec<u32>> {
        if let Some(result) =
            self.with_tree_dom(&self.options, |dom| selector::select(dom, source, contexts))
        {
            return result;
        }
        self.ensure_arena()?;
        selector::select(self.arena.borrow().as_ref().unwrap(), source, contexts)
    }

    fn select_ids(&self, source: &str, contexts: Option<&[u32]>) -> Result<Vec<u32>> {
        self.maybe_collect();
        let contexts = contexts.filter(|contexts| *contexts != [0]);
        if self.arena.borrow().is_some()
            || self.tree_detached.get()
            || contexts.is_some()
            || self.options.get("__losslessUnicode") == Some(&Value::Bool(true))
            || codec::has_encoding(source)
            || source.contains(':')
            || source.contains('\\')
            || source.chars().any(char::is_uppercase)
            || source
                .trim_start()
                .chars()
                .next()
                .is_some_and(|ch| matches!(ch, '>' | '+' | '~'))
            || source.contains("!=")
            || compares_case_insensitive_attribute(source)
        {
            return self.select_native(source, contexts);
        }
        let Some(selector) = parsed_selector(source) else {
            return self.select_native(source, contexts);
        };
        let mut matched = Vec::new();

        if let Some(html) = self.html.borrow().as_ref() {
            for element in html.select(&selector) {
                if let Some(id) = self.reverse.borrow().get(&element.id()) {
                    matched.push(*id);
                }
            }
        }
        matched.sort_unstable();
        matched.dedup();
        Ok(matched)
    }

    fn text_ids(&self, ids: &[u32]) -> String {
        if let Some(arena) = self.arena.borrow().as_ref() {
            return arena.text(ids);
        }
        let mut text = String::new();
        for id in ids {
            self.with_node(*id, |node, _| {
                for descendant in node.descendants() {
                    if let Node::Text(data) = descendant.value() {
                        text.push_str(data);
                    }
                }
            });
        }
        text
    }

    fn attribute(&self, id: u32, name: &str) -> Option<String> {
        if let Some(arena) = self.arena.borrow().as_ref() {
            return arena.attr(id, name).map(str::to_owned);
        }
        self.with_node(id, |node, _| {
            node.value().as_element().and_then(|element| {
                element.attrs.iter().find_map(|(key, value)| {
                    (key.local.as_ref() == name).then(|| value.to_string())
                })
            })
        })
        .flatten()
    }

    fn serialize_nodes(&self, ids: &[u32], children_only: bool) -> String {
        if self.arena.borrow().is_some() {
            let mut arena = self.arena.borrow_mut();
            let arena = arena.as_mut().unwrap();
            return if children_only {
                ids.iter().map(|id| arena.inner_html_mut(*id)).collect()
            } else {
                arena.serialize_mut(ids, &arena.options.clone())
            };
        }
        let mut output = String::new();
        for id in ids {
            self.with_node(*id, |node, _| {
                if children_only {
                    for child in node.children() {
                        serialize_node(child, &mut output);
                    }
                } else {
                    serialize_node(node, &mut output);
                }
            });
        }
        output
    }
}

#[napi]
impl NativeDocument {
    #[napi(constructor)]
    pub fn new(html: String, is_document: bool, options_json: Option<String>) -> Self {
        let options = options_json
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        Self::parse_options(&html, is_document, options, None)
    }

    #[napi]
    pub fn retain(&self, ids: Vec<u32>) {
        self.managed.set(true);
        let mut pins = self.retained.borrow_mut();
        for id in ids {
            if self
                .arena
                .borrow()
                .as_ref()
                .map_or((id as usize) < self.ids.borrow().len(), |arena| {
                    arena.node(id).is_some()
                })
            {
                *pins.entry(id).or_insert(0) += 1;
            }
        }
    }
    #[napi]
    pub fn release(&self, ids: Vec<u32>) {
        let mut pins = self.retained.borrow_mut();
        for id in ids {
            if let Some(count) = pins.get_mut(&id) {
                if *count > 1 {
                    *count -= 1;
                } else {
                    pins.remove(&id);
                    self.needs_collect.set(true);
                }
            }
        }
    }
    /// Every live node that `root` does not reach; a parse tree has none.
    #[napi(js_name = "detachedSlots")]
    pub fn detached_slots(&self, root: u32) -> Uint32Array {
        if let Some(arena) = self.arena.borrow().as_ref() {
            return Uint32Array::from(arena.detached_slots(root));
        }
        Uint32Array::from(self.tree_detached_slots(root))
    }

    /// Nodes removed from the parse tree itself, which keeps them in place
    /// but unreachable from `root`.
    fn tree_detached_slots(&self, root: u32) -> Vec<u32> {
        if !self.tree_detached.get() {
            return Vec::new();
        }
        let html = self.html.borrow();
        let ids = self.ids.borrow();
        let reverse = self.reverse.borrow();
        let Some(root) = html
            .as_ref()
            .zip(ids.get(root as usize))
            .and_then(|(html, id)| html.tree.get(*id))
        else {
            return Vec::new();
        };
        let mut attached = vec![false; ids.len()];
        for node in root.descendants() {
            if let Some(local) = reverse.get(&node.id()) {
                attached[*local as usize] = true;
            }
        }
        (0..ids.len() as u32)
            .filter(|local| !attached[*local as usize])
            .collect()
    }

    /// Sets an attribute on elements, or removes it when `value` is `null`,
    /// exactly as the `attr` command does, without copying an unchanged
    /// document into the mutable arena.
    #[napi(js_name = "setAttribute")]
    pub fn set_attribute(&self, ids: Vec<u32>, name: String, value: Option<String>) -> Result<()> {
        if self.arena.borrow().is_none() && self.source.borrow().is_none() {
            if let Some(html) = self.html.borrow_mut().as_mut() {
                let node_ids = self.ids.borrow();
                for id in &ids {
                    let Some(mut node) = node_ids
                        .get(*id as usize)
                        .and_then(|node_id| html.tree.get_mut(*node_id))
                    else {
                        continue;
                    };
                    if let Node::Element(element) = node.value() {
                        let attributes = with_attribute(element, &name, value.as_deref());
                        *element = scraper::node::Element::new(element.name.clone(), attributes);
                    }
                }
                return Ok(());
            }
        }
        self.ensure_arena()?;
        if let Some(arena) = self.arena_for_attribute_write().as_mut() {
            arena.set_attr(&ids, &name, value.as_deref());
        }
        Ok(())
    }

    /// This document's routing index, assigned on first call. An index is
    /// reused only once its document has been finalized, when nothing in
    /// JavaScript can hold the document's node ids any more.
    #[napi(js_name = "routingIndex")]
    pub fn routing_index(&self) -> u32 {
        if let Some(index) = self.routing_index.get() {
            return index;
        }
        let index = FREE_ROUTING_INDEXES
            .with(|free| free.borrow_mut().pop())
            .unwrap_or_else(|| {
                NEXT_ROUTING_INDEX.with(|next| {
                    let index = next.get();
                    next.set(index.saturating_add(1));
                    index
                })
            });
        self.routing_index.set(Some(index));
        index
    }

    /// Documents in this process whose native storage has not been dropped,
    /// for tests of memory release; resident memory is a noisy signal.
    #[napi(js_name = "liveDocumentCount")]
    pub fn live_document_count(&self) -> u32 {
        LIVE_DOCUMENTS.load(std::sync::atomic::Ordering::Relaxed) as u32
    }

    /// Whether removed created nodes and arena growth make a collection worthwhile.
    #[napi(js_name = "isCollectionDue")]
    pub fn is_collection_due(&self) -> bool {
        self.arena
            .borrow()
            .as_ref()
            .is_some_and(arena::DomArena::is_collection_due)
    }

    /// The number of node slots, including released ones.
    #[napi(js_name = "slotCount")]
    pub fn slot_count(&self) -> u32 {
        match self.arena.borrow().as_ref() {
            Some(arena) => arena.nodes.len() as u32,
            None => self.ids.borrow().len() as u32,
        }
    }

    /// Parents whose child lists changed since the last call; `null` when
    /// too many changed to list and every parent must be treated as changed.
    #[napi(js_name = "takeTouched")]
    pub fn take_touched(&self) -> Option<Uint32Array> {
        let removed = std::mem::take(&mut *self.tree_touched.borrow_mut());
        match self.arena_for_write().as_mut() {
            Some(arena) => arena.take_touched().map(|mut touched| {
                touched.extend(removed);
                Uint32Array::from(touched)
            }),
            None => Some(Uint32Array::from(removed)),
        }
    }

    /// Removes nodes from the parse tree itself: the common clean-up before
    /// reading text or markup then needs no copy into the mutable arena.
    fn remove_from_tree(&self, ids: &[u32]) {
        let mut html = self.html.borrow_mut();
        let Some(html) = html.as_mut() else {
            return;
        };
        let node_ids = self.ids.borrow();
        let reverse = self.reverse.borrow();
        let mut touched = self.tree_touched.borrow_mut();
        for id in ids {
            let Some(node_id) = node_ids.get(*id as usize) else {
                continue;
            };
            let Some(mut node) = html.tree.get_mut(*node_id) else {
                continue;
            };
            let Some(parent) = node.parent().map(|parent| parent.id()) else {
                continue;
            };
            node.detach();
            touched.extend(reverse.get(&parent).copied());
        }
        self.tree_detached.set(true);
        *self.tree_index.borrow_mut() = None;
    }

    /// Replaces every pin with `pins`, the nodes JavaScript still references,
    /// then reclaims detached nodes that are neither pinned, below
    /// `keep_below`, nor connected to such a node. Computing pins at
    /// collection time lets JavaScript track references without a native call
    /// per node.
    #[napi(js_name = "collectPinned")]
    pub fn collect_pinned(
        &self,
        env: Env,
        pins: Uint32Array,
        keep_below: Option<u32>,
    ) -> PinnedCollection {
        self.kept_slots.set(keep_below.unwrap_or(0));
        let mut retained = HashMap::new();
        {
            let arena = self.arena.borrow();
            let immutable_count = self.ids.borrow().len();
            for id in pins.iter() {
                let exists = arena
                    .as_ref()
                    .map_or((*id as usize) < immutable_count, |arena| {
                        arena.node(*id).is_some()
                    });
                if exists {
                    *retained.entry(*id).or_insert(0) += 1;
                }
            }
        }
        *self.retained.borrow_mut() = retained;
        self.managed.set(true);
        let stats = self.collect_garbage_and_report(env);
        let free = self
            .arena
            .borrow()
            .as_ref()
            .map(|arena| arena.free.clone())
            .unwrap_or_default();
        PinnedCollection {
            live: stats.live,
            slots: stats.slots,
            retained: stats.retained,
            reclaimed: stats.reclaimed,
            immutable_nodes: stats.immutable_nodes,
            external_bytes: stats.external_bytes,
            free: free.into(),
        }
    }

    #[napi(js_name = "collectGarbage")]
    pub fn collect_garbage_and_report(&self, env: Env) -> MemoryStats {
        let stats = self.collect_garbage();
        self.report_heap_bytes(env);
        MemoryStats {
            external_bytes: self.reported_heap_bytes.get(),
            ..stats
        }
    }

    pub fn collect_garbage(&self) -> MemoryStats {
        self.needs_collect.set(false);
        if self.arena.borrow().is_none()
            && self.managed.get()
            && self.kept_slots.get() == 0
            && self.retained.borrow().is_empty()
        {
            self.html.borrow_mut().take();
            self.source.borrow_mut().take();
            let reclaimed = self.ids.borrow().len() as u32;
            *self.ids.borrow_mut() = Vec::new();
            *self.reverse.borrow_mut() = id_hash::IdMap::default();
            *self.tree_index.borrow_mut() = None;
            return MemoryStats {
                live: 0,
                slots: 0,
                retained: 0,
                reclaimed,
                immutable_nodes: 0,
                external_bytes: self.reported_heap_bytes.get(),
            };
        }
        if let Some(arena) = self.arena_for_write().as_mut() {
            let stats = gc::collect_managed(
                arena,
                &self.retained.borrow(),
                !self.managed.get(),
                self.kept_slots.get(),
            );
            arena.free = stats.free;
            MemoryStats {
                live: stats.live,
                slots: stats.slots,
                retained: stats.retained,
                reclaimed: stats.reclaimed,
                immutable_nodes: 0,
                external_bytes: self.reported_heap_bytes.get(),
            }
        } else {
            let count = self.ids.borrow().len() as u32;
            MemoryStats {
                live: count,
                slots: count,
                retained: self.retained.borrow().len() as u32,
                reclaimed: 0,
                immutable_nodes: count,
                external_bytes: self.reported_heap_bytes.get(),
            }
        }
    }

    #[napi]
    pub fn parser_diagnostics(&self) -> Result<String> {
        serde_json::to_string(&*self.diagnostics.borrow()).map_err(json_error)
    }

    #[napi]
    pub fn root_id(&self, env: Env) -> u32 {
        self.report_heap_bytes(env);
        0
    }

    #[napi(js_name = "select")]
    pub fn select_and_report(
        &self,
        env: Env,
        selector: String,
        contexts: Option<Vec<u32>>,
    ) -> Result<Vec<u32>> {
        self.reported(env, self.select(selector, contexts))
    }

    pub fn select(&self, selector: String, contexts: Option<Vec<u32>>) -> Result<Vec<u32>> {
        self.select_ids(&selector, contexts.as_deref())
    }

    #[napi]
    pub fn matches(&self, env: Env, selector: String, ids: Vec<u32>) -> Result<Vec<u32>> {
        self.ensure_arena()?;
        let matched = selector::filter(self.arena.borrow().as_ref().unwrap(), &selector, &ids);
        self.reported(env, matched)
    }

    #[napi]
    pub fn element_ids(&self) -> Vec<u32> {
        if let Some(arena) = self.arena.borrow().as_ref() {
            return arena
                .nodes
                .iter()
                .filter(|node| node.is_element())
                .map(|node| node.id)
                .collect();
        }
        self.ids
            .borrow()
            .iter()
            .enumerate()
            .filter_map(|(id, _)| {
                self.with_node(id as u32, |node, _| node.value().is_element())
                    .unwrap_or(false)
                    .then_some(id as u32)
            })
            .collect()
    }

    /// The results of the extraction plans `parseManyAsync` ran on the
    /// document's root while parsing it, each `null` if it failed; `null`
    /// after the first call.
    #[napi(
        js_name = "takePreparedPlans",
        ts_return_type = "Array<string | null> | null"
    )]
    pub fn take_prepared_plans(&self) -> Option<Vec<Option<JsText>>> {
        self.prepared_plans.borrow_mut().take().map(|results| {
            results
                .into_iter()
                .map(|result| result.map(JsText))
                .collect()
        })
    }

    /// The snapshot `parseManyAsync` built while parsing the document, if it
    /// did; `null` after the first call, which discards it unless `is_wanted`.
    /// It describes the parsed tree, so JavaScript discards it on its first write.
    #[napi(js_name = "takePreparedSnapshot")]
    pub fn take_prepared_snapshot(&self, env: Env, is_wanted: bool) -> Result<Option<Object>> {
        let prepared = self.prepared_snapshot.borrow_mut().take();
        match prepared {
            Some(snapshot) if is_wanted => snapshot.into_js(&env).map(Some),
            _ => Ok(None),
        }
    }

    #[napi(js_name = "text", ts_return_type = "string")]
    pub fn text_for_js(&self, ids: Vec<u32>) -> JsText {
        JsText(self.text(ids))
    }

    pub fn text(&self, ids: Vec<u32>) -> String {
        self.text_ids(&ids)
    }

    #[napi(js_name = "innerHtml", ts_return_type = "string")]
    pub fn inner_html_and_report(&self, env: Env, id: u32) -> JsText {
        JsText(self.reported(env, self.inner_html(id)))
    }

    pub fn inner_html(&self, id: u32) -> String {
        if (self.tag_name(id).as_deref() == Some("template") || self.arena.borrow().is_some())
            && self.ensure_arena().is_ok()
        {
            return self.arena_for_write().as_mut().unwrap().inner_html_mut(id);
        }
        self.serialize_nodes(&[id], true)
    }

    #[napi(js_name = "outerHtml", ts_return_type = "string")]
    pub fn outer_html_for_js(&self, ids: Vec<u32>) -> JsText {
        JsText(self.outer_html(ids))
    }

    pub fn outer_html(&self, ids: Vec<u32>) -> String {
        self.serialize_nodes(&ids, false)
    }

    /// Serializes nodes as the `render` command does, returning the markup
    /// itself rather than markup encoded as JSON.
    #[napi(js_name = "render", ts_return_type = "string")]
    pub fn render_and_report(
        &self,
        env: Env,
        ids: Vec<u32>,
        options_json: Option<String>,
    ) -> Result<JsText> {
        self.maybe_collect();
        let overrides = match options_json {
            Some(json) => Some(serde_json::from_str::<Value>(&json).map_err(json_error)?),
            None => None,
        }
        .filter(Value::is_object);
        let rendered = self.render_nodes(&ids, overrides)?;
        Ok(JsText(self.reported(env, rendered)))
    }

    fn render_nodes(&self, ids: &[u32], overrides: Option<Value>) -> Result<String> {
        if self.arena.borrow().is_none() {
            let mut options = self.options.clone();
            if let Some(Value::Object(overrides)) = &overrides {
                for (key, value) in overrides {
                    options[key] = value.clone();
                }
            }
            let options = arena::normalized_options(options);
            if !arena::xml_mode(&options)
                && options.get("_useHtmlParser2") != Some(&Value::Bool(true))
            {
                return Ok(self.serialize_nodes(ids, false));
            }
        }
        self.ensure_arena()?;
        let mut arena = self.arena.borrow_mut();
        let arena = arena.as_mut().unwrap();
        let mut options = match overrides {
            Some(overrides) => arena::normalized_options(overrides),
            None => arena.options.clone(),
        };
        if self.options.get("__utf16Codec") == Some(&Value::Bool(true)) {
            options["__utf16Codec"] = Value::Bool(true);
        }
        Ok(arena.serialize_mut(ids, &arena::normalized_options(options)))
    }

    #[napi(js_name = "attr", ts_return_type = "string | null")]
    pub fn attr_for_js(&self, id: u32, name: String) -> Option<JsText> {
        self.attr(id, name).map(JsText)
    }

    pub fn attr(&self, id: u32, name: String) -> Option<String> {
        self.attribute(id, &name)
    }

    #[napi]
    pub fn tag_name(&self, id: u32) -> Option<String> {
        if let Some(arena) = self.arena.borrow().as_ref() {
            return arena.node(id).and_then(|node| node.name.clone());
        }
        self.with_node(id, |node, _| {
            node.value()
                .as_element()
                .map(|element| element.name().to_string())
        })
        .flatten()
    }

    #[napi(js_name = "exportTree", ts_return_type = "string")]
    pub fn export_tree_and_report(&self, env: Env) -> Result<JsText> {
        self.reported(env, self.export_tree()).map(JsText)
    }

    pub fn export_tree(&self) -> Result<String> {
        if self.source.borrow().is_some() {
            self.ensure_arena()?;
        }
        if let Some(arena) = self.arena.borrow().as_ref() {
            return serde_json::to_string(&arena.nodes).map_err(json_error);
        }
        let records: Vec<_> = (0..self.ids.borrow().len())
            .filter_map(|id| self.immutable_dom_node(id as u32))
            .collect();
        serde_json::to_string(&records).map_err(json_error)
    }

    /// Every node record at once, in the compact form `snapshot.rs` describes.
    #[napi]
    pub fn snapshot(&self, env: Env) -> Result<Object> {
        self.maybe_collect();
        if self.source.borrow().is_some() {
            self.ensure_arena()?;
        }
        let built = snapshot::build(self);
        self.report_heap_bytes(env);
        built.into_js(&env)
    }

    #[napi(js_name = "node", ts_return_type = "string")]
    pub fn node_and_report(&self, env: Env, id: u32) -> Result<JsText> {
        self.reported(env, self.node(id)).map(JsText)
    }

    pub fn node(&self, id: u32) -> Result<String> {
        if self.source.borrow().is_some() {
            self.ensure_arena()?;
        }
        if self.arena.borrow().is_none() {
            return serde_json::to_string(&self.immutable_record(id)).map_err(json_error);
        }
        serde_json::to_string(&self.arena.borrow().as_ref().unwrap().node(id)).map_err(json_error)
    }

    #[napi(js_name = "create")]
    pub fn create_and_report(
        &self,
        env: Env,
        html: String,
        context_id: Option<u32>,
        options_json: Option<String>,
    ) -> Result<Vec<u32>> {
        let created = self.create(html, context_id, options_json);
        self.reported(env, created)
    }

    pub fn create(
        &self,
        html: String,
        context_id: Option<u32>,
        _options_json: Option<String>,
    ) -> Result<Vec<u32>> {
        self.content_bytes
            .set(self.content_bytes.get().saturating_add(html.len()));
        self.ensure_arena()?;
        self.arena
            .borrow_mut()
            .as_mut()
            .unwrap()
            .create_fragment(&html, context_id)
    }

    /// Move a branch between native documents. JavaScript only redirects its
    /// existing stable handles using the returned complete descendant mapping.
    #[napi(js_name = "adopt")]
    pub fn adopt_and_report(
        &self,
        env: Env,
        source: &NativeDocument,
        ids: Vec<u32>,
        detach: Option<bool>,
    ) -> Result<String> {
        let adopted = self.adopt(source, ids, detach);
        source.report_heap_bytes(env);
        self.reported(env, adopted)
    }

    pub fn adopt(
        &self,
        source: &NativeDocument,
        ids: Vec<u32>,
        detach: Option<bool>,
    ) -> Result<String> {
        if std::ptr::eq(self, source) {
            return serde_json::to_string(&serde_json::json!({"roots":ids,"mapping":ids.iter().map(|id|[*id,*id]).collect::<Vec<_>>()})).map_err(json_error);
        }
        self.ensure_arena()?;
        source.ensure_arena()?;
        let mut source_arena = source.arena_for_write();
        let source_arena = source_arena.as_mut().unwrap();
        // Detach all requested roots first: overlapping roots become siblings
        // and each requested descendant is imported exactly once.
        if detach.unwrap_or(true) {
            source_arena.detach_many(&ids);
        }
        let mut seen = HashSet::new();
        let mut moved = Vec::new();
        let mut stack: Vec<_> = ids.iter().rev().copied().collect();
        while let Some(id) = stack.pop() {
            if !seen.insert(id) {
                continue;
            }
            if let Some(node) = source_arena.node(id) {
                moved.push(id);
                stack.extend(node.children.iter().rev().copied());
            }
        }
        let mut target_arena = self.arena_for_write();
        let target_arena = target_arena.as_mut().unwrap();
        target_arena.nodes.reserve(moved.len());
        let (roots, mapping) = if detach.unwrap_or(true) {
            let mapping: Vec<_> = moved
                .iter()
                .map(|id| [*id, target_arena.push(arena::DomNode::new("released"))])
                .collect();
            let remap: HashMap<_, _> = mapping.iter().map(|pair| (pair[0], pair[1])).collect();
            for id in &moved {
                let mut tombstone = arena::DomNode::new("released");
                tombstone.id = *id;
                let mut node = std::mem::replace(&mut source_arena.nodes[*id as usize], tombstone);
                source_arena.free.push(*id);
                node.id = remap[id];
                node.children.retain_mut(|child| {
                    if let Some(mapped) = remap.get(child) {
                        *child = *mapped;
                        true
                    } else {
                        false
                    }
                });
                node.parent = node.parent.and_then(|id| remap.get(&id).copied());
                node.prev = node.prev.and_then(|id| remap.get(&id).copied());
                node.next = node.next.and_then(|id| remap.get(&id).copied());
                let new_id = node.id;
                target_arena.nodes[new_id as usize] = node;
                if let Some(count) = source.retained.borrow_mut().remove(id) {
                    *self.retained.borrow_mut().entry(new_id).or_insert(0) += count;
                }
            }
            for pair in &mapping {
                target_arena.relink(pair[1]);
            }
            (
                ids.iter()
                    .filter_map(|id| remap.get(id).copied())
                    .collect::<Vec<_>>(),
                mapping,
            )
        } else {
            // Imported roots use the original preorder allocation. Preserve
            // a complete mapping even when this arena has recyclable slots.
            let free = std::mem::take(&mut target_arena.free);
            let first = target_arena.nodes.len() as u32;
            let records: Vec<_> = moved
                .iter()
                .filter_map(|id| source_arena.node(*id).cloned())
                .collect();
            let roots = target_arena.import(&records, &ids);
            let mapping = moved
                .iter()
                .enumerate()
                .map(|(index, id)| [*id, first + index as u32])
                .collect::<Vec<_>>();
            target_arena.free = free;
            (roots, mapping)
        };
        serde_json::to_string(&serde_json::json!({"roots":roots,"mapping":mapping}))
            .map_err(json_error)
    }

    #[napi(js_name = "op", ts_return_type = "string")]
    pub fn op_and_report(&self, env: Env, command: String, args_json: String) -> Result<JsText> {
        self.reported(env, self.op(command, args_json)).map(JsText)
    }

    pub fn op(&self, command: String, args_json: String) -> Result<String> {
        self.maybe_collect();
        let args: Value = serde_json::from_str(&args_json).map_err(json_error)?;
        if command == "node" {
            return self.node(args["id"].as_u64().unwrap_or(0) as u32);
        }
        if command == "remove"
            && args["keepChildren"].as_bool() != Some(true)
            && self.arena.borrow().is_none()
            && self.source.borrow().is_none()
        {
            self.remove_from_tree(&arena::value_ids(&args["ids"]));
            return Ok("null".into());
        }
        if self.arena.borrow().is_none() {
            let ids = arena::value_ids(&args["ids"]);
            let effective_options = arena::normalized_options(
                args.get("options")
                    .filter(|options| options.is_object())
                    .cloned()
                    .unwrap_or_else(|| self.options.clone()),
            );
            if command == "attr" && args.get("value").is_none() {
                let name = args["name"].as_str().unwrap_or("");
                let result = ids
                    .first()
                    .and_then(|id| {
                        let element_name = self.tag_name(*id)?;
                        if name.is_empty() {
                            return self
                                .immutable_record(*id)
                                .and_then(|value| value.get("attribs").cloned());
                        }
                        if let Some(value) = self.attribute(*id, name) {
                            let boolean = matches!(
                                name.to_ascii_lowercase().as_str(),
                                "autofocus"
                                    | "autoplay"
                                    | "async"
                                    | "checked"
                                    | "controls"
                                    | "defer"
                                    | "disabled"
                                    | "hidden"
                                    | "loop"
                                    | "multiple"
                                    | "open"
                                    | "readonly"
                                    | "required"
                                    | "scoped"
                                    | "selected"
                            );
                            return Some(Value::String(
                                if boolean && !arena::xml_mode(&effective_options) {
                                    name.into()
                                } else {
                                    value
                                },
                            ));
                        }
                        if name == "value" {
                            if element_name == "option" {
                                return Some(Value::String(self.text_ids(&[*id])));
                            }
                            if element_name == "input"
                                && matches!(
                                    self.attribute(*id, "type").as_deref(),
                                    Some("radio" | "checkbox")
                                )
                            {
                                return Some(serde_json::json!("on"));
                            }
                        }
                        None
                    })
                    .unwrap_or(Value::Null);
                return serde_json::to_string(&result).map_err(json_error);
            }
            if let Some(result) = self.tree_read(&command, &args, &ids, &effective_options) {
                return serde_json::to_string(&result?).map_err(json_error);
            }
            if let Some(result) =
                self.tree_attribute_write(&command, &args, &ids, &effective_options)
            {
                return serde_json::to_string(&result?).map_err(json_error);
            }
            if command == "render" || command == "outerHtml" {
                let mut options = self.options.clone();
                if let Some(overrides) = args.get("options").and_then(Value::as_object) {
                    for (key, value) in overrides {
                        options[key] = value.clone();
                    }
                }
                let options = arena::normalized_options(options);
                if !arena::xml_mode(&options)
                    && options.get("_useHtmlParser2") != Some(&Value::Bool(true))
                {
                    return serde_json::to_string(&self.serialize_nodes(&ids, false))
                        .map_err(json_error);
                }
            }
        }
        self.ensure_arena()?;
        let mut arena = if attributes::keeps_element_names(&command) {
            self.arena_for_attribute_write()
        } else {
            self.arena_for_write()
        };
        let arena = arena.as_mut().unwrap();
        let previous_options = arena.options.clone();
        if let Some(options) = args.get("options").filter(|options| options.is_object()) {
            arena.options = arena::normalized_options(options.clone());
            if self.options.get("__utf16Codec") == Some(&Value::Bool(true)) {
                arena.options["__utf16Codec"] = Value::Bool(true);
            }
        }
        let result = (|| -> Result<Value> {
            if command == "extractPlan" {
                return extraction::execute_arena(
                    arena,
                    &args["plan"],
                    &arena::value_ids(&args["ids"]),
                );
            }
            if let Some(result) = attributes::execute(arena, &command, &args)? {
                Ok(result)
            } else {
                arena::primitive(arena, &command, &args)
            }
        })();
        arena.options = previous_options;
        let result = result?;
        serde_json::to_string(&result).map_err(json_error)
    }
}

#[napi(object)]
pub struct PinnedCollection {
    pub live: u32,
    pub slots: u32,
    pub retained: u32,
    pub reclaimed: u32,
    pub immutable_nodes: u32,
    pub external_bytes: i64,
    /// Slots that hold no node after collection.
    pub free: Uint32Array,
}

#[napi(object)]
pub struct MemoryStats {
    pub live: u32,
    pub slots: u32,
    pub retained: u32,
    pub reclaimed: u32,
    pub immutable_nodes: u32,
    /// Native bytes currently reported to V8 for this document.
    pub external_bytes: i64,
}

/// The Cheerio DOM adapter exposes foreign attributes by local name, whereas
/// CSS normally limits unprefixed attribute selectors to the empty namespace.
/// A wildcard prefix restores the adapter's matching rules. Preserve explicit
/// namespaces, quoted values, and escapes while scanning selector syntax.
fn normalize_attribute_namespaces(source: &str) -> Cow<'_, str> {
    let bytes = source.as_bytes();
    let mut insertions = Vec::new();
    let mut quote = None;
    let mut index = 0;
    while index < bytes.len() {
        let current = bytes[index];
        if current == b'\\' {
            index += 2;
            continue;
        }
        if let Some(quoted) = quote {
            if current == quoted {
                quote = None;
            }
        } else if current == b'\'' || current == b'"' {
            quote = Some(current);
        } else if current == b'[' {
            let mut start = index + 1;
            while start < bytes.len() && bytes[start].is_ascii_whitespace() {
                start += 1;
            }
            let mut cursor = start;
            let mut explicit_namespace = false;
            while cursor < bytes.len() {
                let ch = bytes[cursor];
                if ch == b'\\' {
                    cursor += 2;
                    continue;
                }
                if ch == b'|' && bytes.get(cursor + 1) != Some(&b'=') {
                    explicit_namespace = true;
                    break;
                }
                if ch == b']'
                    || ch == b'='
                    || ch.is_ascii_whitespace()
                    || (matches!(ch, b'~' | b'^' | b'$' | b'*' | b'!' | b'|')
                        && bytes.get(cursor + 1) == Some(&b'='))
                {
                    break;
                }
                cursor += 1;
            }
            if !explicit_namespace && start < bytes.len() {
                insertions.push(start);
            }
        }
        index += 1;
    }
    if insertions.is_empty() {
        return Cow::Borrowed(source);
    }
    let mut normalized = String::with_capacity(source.len() + insertions.len() * 2);
    let mut previous = 0;
    for insertion in insertions {
        normalized.push_str(&source[previous..insertion]);
        normalized.push_str("*|");
        previous = insertion;
    }
    normalized.push_str(&source[previous..]);
    Cow::Owned(normalized)
}

/// An element's attributes after setting or removing `name`. Attributes are
/// keyed by local name as in the arena: a repeated local name keeps its first
/// position, with the name and value of its last occurrence.
fn with_attribute(
    element: &scraper::node::Element,
    name: &str,
    value: Option<&str>,
) -> Vec<html5ever::Attribute> {
    let mut attributes: Vec<html5ever::Attribute> = Vec::with_capacity(element.attrs.len() + 1);
    for (key, current) in &element.attrs {
        let attribute = html5ever::Attribute {
            name: key.clone(),
            value: current.as_ref().into(),
        };
        match attributes
            .iter_mut()
            .find(|existing| existing.name.local == key.local)
        {
            Some(existing) => *existing = attribute,
            None => attributes.push(attribute),
        }
    }
    match value {
        Some(value) => match attributes
            .iter_mut()
            .find(|attribute| attribute.name.local.as_ref() == name)
        {
            Some(attribute) => attribute.value = value.into(),
            None => attributes.push(html5ever::Attribute {
                name: html5ever::QualName::new(
                    None,
                    html5ever::ns!(),
                    html5ever::LocalName::from(name),
                ),
                value: value.into(),
            }),
        },
        None => attributes.retain(|attribute| attribute.name.local.as_ref() != name),
    }
    attributes
}

thread_local! {
    /// Parse-tree selectors by source, or `None` for sources they cannot express.
    static SELECTORS: RefCell<HashMap<String, Option<std::rc::Rc<Selector>>>> = RefCell::new(HashMap::new());
}

/// A selector for the parse tree, parsed once per source per thread.
fn parsed_selector(source: &str) -> Option<std::rc::Rc<Selector>> {
    if let Some(parsed) = SELECTORS.with(|cache| cache.borrow().get(source).cloned()) {
        return parsed;
    }
    let parsed = Selector::parse(&normalize_attribute_namespaces(source))
        .ok()
        .map(std::rc::Rc::new);
    SELECTORS.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() >= 512 {
            cache.clear();
        }
        cache.insert(source.to_owned(), parsed.clone());
    });
    parsed
}

/// Whether a selector compares the value of an attribute whose values HTML
/// matches without regard to case, which the parse-tree selector engine does not.
fn compares_case_insensitive_attribute(source: &str) -> bool {
    source.contains('=')
        && source.match_indices('[').any(|(index, _)| {
            let name: String = source[index + 1..]
                .trim_start()
                .chars()
                .take_while(|character| character.is_ascii_alphanumeric() || *character == '-')
                .collect();
            selector::CASE_INSENSITIVE_ATTRIBUTES
                .iter()
                .any(|candidate| name.eq_ignore_ascii_case(candidate))
        })
}

/// `source` with CRLF and CR replaced by LF, as HTML5 input preprocessing does.
fn normalize_newlines(source: &str) -> String {
    let mut output = String::with_capacity(source.len());
    let mut rest = source;
    while let Some(index) = rest.find('\r') {
        output.push_str(&rest[..index]);
        output.push('\n');
        rest = &rest[index + 1..];
        if let Some(stripped) = rest.strip_prefix('\n') {
            rest = stripped;
        }
    }
    output.push_str(rest);
    output
}

/// Whether HTML5 parses `source` as a fragment to a single text node holding
/// it unchanged: no markup, character references, carriage returns to
/// normalize or NUL characters to replace.
fn is_plain_text(source: &str) -> bool {
    !source
        .bytes()
        .any(|byte| matches!(byte, b'<' | b'&' | b'\r' | b'\0'))
}

/// The fragment HTML5 builds from plain text, without running the parser,
/// whose fixed setup costs more than parsing a short string.
fn plain_text_fragment(source: &str) -> Html {
    let mut html = Html::new_fragment();
    if !source.is_empty() {
        html.tree.root_mut().append(Node::Text(scraper::node::Text {
            text: source.into(),
        }));
    }
    html
}

/// A parse target with node storage sized for `source`: grown one
/// reallocation at a time, it copies every node again, which dominates the
/// parse of small inputs. Large documents grow from the cap.
fn sized_html(source: &str, is_document: bool) -> Html {
    const MAXIMUM_INITIAL_NODES: usize = 4096;
    let capacity = (source.len() / 16 + 8).min(MAXIMUM_INITIAL_NODES);
    let mut html = if is_document {
        Html::new_document()
    } else {
        Html::new_fragment()
    };
    let root = if is_document {
        Node::Document
    } else {
        Node::Fragment
    };
    html.tree = ego_tree::Tree::with_capacity(root, capacity);
    html
}

/// html5ever's fragment sink creates a synthetic html element; Cheerio
/// exposes the fragment's actual children at its root. Children move one at a
/// time because `reparent_from_id_append` only re-points the first and last
/// moved child at their new parent.
fn unwrap_fragment_root(html: &mut Html) {
    let wrapper = html.tree.root().children().find_map(|node| {
        node.value()
            .as_element()
            .filter(|element| element.name() == "html")
            .map(|_| node.id())
    });
    let Some(wrapper) = wrapper else { return };
    let children: Vec<NodeId> = html
        .tree
        .get(wrapper)
        .map(|node| node.children().map(|child| child.id()).collect())
        .unwrap_or_default();
    let mut root = html.tree.root_mut();
    for child in children {
        root.append_id(child);
    }
    html.tree.get_mut(wrapper).unwrap().detach();
}

/// Nodes converted per worker task when copying a parse tree into the arena.
const CONVERSION_CHUNK: usize = 2048;

/// A parse tree read by several workers at once while copying it into the
/// mutable arena.
struct SharedTree<'a> {
    html: &'a Html,
    ids: &'a [NodeId],
    reverse: &'a id_hash::IdMap<NodeId, u32>,
}

// SAFETY: `Html` is not `Sync` only because elements cache their id and
// classes in `OnceCell`s and tendrils keep their header in `Cell`s. Conversion
// reads names, attribute lists and text through shared references and never
// touches those caches, and the owning thread waits for the workers, so no
// write can race these reads.
unsafe impl Sync for SharedTree<'_> {}

impl SharedTree<'_> {
    fn convert(&self, range: std::ops::Range<usize>) -> Vec<arena::DomNode> {
        let mut nodes = Vec::with_capacity(range.len());
        nodes.extend(
            range.filter_map(|id| convert_node(self.html, self.ids, self.reverse, id as u32)),
        );
        nodes
    }
}

/// A parse-tree node as a mutable-arena record. It reads only names,
/// attributes and text, never the tree's lazily filled caches.
fn convert_node(
    html: &Html,
    ids: &[NodeId],
    reverse: &id_hash::IdMap<NodeId, u32>,
    id: u32,
) -> Option<arena::DomNode> {
    let node = html.tree.get(*ids.get(id as usize)?)?;
    let pointer =
        |node: Option<NodeRef<'_, Node>>| node.and_then(|node| reverse.get(&node.id()).copied());
    let mut record = arena::DomNode::new("root");
    record.id = id;
    record.children = node
        .children()
        .filter_map(|child| reverse.get(&child.id()).copied())
        .collect();
    record.parent = pointer(node.parent());
    record.prev = pointer(node.prev_sibling());
    record.next = pointer(node.next_sibling());
    match node.value() {
        Node::Document => {
            record.extras.insert(
                "x-mode".into(),
                Value::String(
                    match html.quirks_mode {
                        html5ever::tree_builder::QuirksMode::Quirks => "quirks",
                        html5ever::tree_builder::QuirksMode::LimitedQuirks => "limited-quirks",
                        html5ever::tree_builder::QuirksMode::NoQuirks => "no-quirks",
                    }
                    .into(),
                ),
            );
        }
        Node::Fragment => {}
        Node::Text(data) => {
            record.kind = "text".into();
            record.data = Some(String::from(&**data));
        }
        Node::Comment(data) => {
            record.kind = "comment".into();
            record.data = Some(String::from(&**data));
        }
        Node::Doctype(data) => {
            record.kind = "directive".into();
            record.name = Some("!doctype".into());
            record
                .extras
                .insert("x-name".into(), Value::String(data.name().into()));
            record
                .extras
                .insert("x-publicId".into(), Value::String(data.public_id().into()));
            record
                .extras
                .insert("x-systemId".into(), Value::String(data.system_id().into()));
            record.data = Some(doctype_content(data));
        }
        Node::ProcessingInstruction(data) => {
            record.kind = "directive".into();
            record.name = Some(String::from(&*data.target));
            record.data = Some(String::from(&*data.data));
        }
        Node::Element(element) => {
            record.kind = match element.name() {
                "script" => "script",
                "style" => "style",
                _ => "tag",
            }
            .into();
            record.name = Some(element.name().into());
            record.namespace = Some(arena::namespace_name(&element.name.ns));
            if let Some(prefix) = &element.name.prefix {
                record
                    .extras
                    .insert("prefix".into(), Value::String(String::from(&**prefix)));
            }
            let (mut namespaces, mut prefixes) = (Map::new(), Map::new());
            if !element.attrs.is_empty() {
                record.attribs = arena::Attributes::with_capacity(element.attrs.len());
            }
            for (name, value) in &element.attrs {
                let key = String::from(&*name.local);
                if !name.ns.is_empty() {
                    namespaces.insert(key.clone(), Value::String(String::from(&*name.ns)));
                }
                if let Some(prefix) = &name.prefix {
                    prefixes.insert(key.clone(), Value::String(String::from(&**prefix)));
                }
                record
                    .attribs
                    .insert(key, Value::String(String::from(&**value)));
            }
            record.attribs_namespace = Some(Box::new(namespaces));
            record.attribs_prefix = Some(Box::new(prefixes));
        }
    }
    Some(record)
}

/// A doctype's `data`, as htmlparser2 reports the declaration.
pub(crate) fn doctype_content(data: &scraper::node::Doctype) -> String {
    let mut content = format!("!DOCTYPE {}", data.name());
    if !data.public_id().is_empty() {
        content.push_str(" PUBLIC ");
        content.push_str(&quote_doctype(data.public_id()));
    } else if !data.system_id().is_empty() {
        content.push_str(" SYSTEM");
    }
    if !data.system_id().is_empty() {
        content.push(' ');
        content.push_str(&quote_doctype(data.system_id()));
    }
    content
}

fn quote_doctype(value: &str) -> String {
    let quote = if value.contains('"') { '\'' } else { '"' };
    format!("{quote}{value}{quote}")
}

fn json_error(error: serde_json::Error) -> Error {
    Error::new(Status::GenericFailure, error.to_string())
}

fn escape_html(value: &str, attribute: bool, output: &mut String) {
    let mut start = 0;
    for (offset, ch) in value.char_indices() {
        let replacement = match ch {
            '&' => "&amp;",
            '\u{a0}' => "&nbsp;",
            '"' if attribute => "&quot;",
            '<' if !attribute => "&lt;",
            '>' if !attribute => "&gt;",
            _ => continue,
        };
        output.push_str(&value[start..offset]);
        output.push_str(replacement);
        start = offset + ch.len_utf8();
    }
    output.push_str(&value[start..]);
}

fn is_void(element: &scraper::node::Element) -> bool {
    element.name.ns.as_ref() == HTML_NS && void_name(element.name())
}

pub(crate) fn void_name(name: &str) -> bool {
    matches!(
        name,
        "area"
            | "base"
            | "basefont"
            | "bgsound"
            | "br"
            | "col"
            | "embed"
            | "frame"
            | "hr"
            | "img"
            | "input"
            | "keygen"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}

fn serialize_node(node: NodeRef<'_, Node>, output: &mut String) {
    // Use the tree's iterative traversal so deeply nested untrusted HTML does
    // not consume the native stack during serialization.
    for edge in node.traverse() {
        let node = match edge {
            ego_tree::iter::Edge::Open(node) => node,
            ego_tree::iter::Edge::Close(node) => {
                if let Some(element) = node
                    .value()
                    .as_element()
                    .filter(|element| !is_void(element))
                {
                    output.push_str("</");
                    output.push_str(element.name());
                    output.push('>');
                }
                continue;
            }
        };
        match node.value() {
            Node::Document | Node::Fragment => {}
            Node::Text(text) => {
                let raw = node
                    .parent()
                    .and_then(|parent| parent.value().as_element())
                    .is_some_and(|element| {
                        element.name.ns.as_ref() == HTML_NS
                            && matches!(
                                element.name(),
                                "script"
                                    | "style"
                                    | "xmp"
                                    | "iframe"
                                    | "noembed"
                                    | "noframes"
                                    | "plaintext"
                                    | "noscript"
                            )
                    });
                if raw {
                    output.push_str(text);
                } else {
                    escape_html(text, false, output);
                }
            }
            Node::Comment(comment) => {
                output.push_str("<!--");
                output.push_str(comment);
                output.push_str("-->");
            }
            Node::Doctype(doctype) => {
                output.push_str("<!DOCTYPE ");
                output.push_str(doctype.name());
                output.push('>');
            }
            Node::ProcessingInstruction(instruction) => {
                output.push_str("<?");
                output.push_str(&instruction.target);
                output.push(' ');
                output.push_str(&instruction.data);
                output.push_str("?>");
            }
            Node::Element(element) => {
                output.push('<');
                output.push_str(element.name());
                let attributes = js_property_order(
                    element
                        .attrs
                        .iter()
                        .map(|(name, value)| (name.local.as_ref(), (name, value))),
                );
                for (_, (name, value)) in attributes {
                    output.push(' ');
                    push_attribute_name(
                        output,
                        &name.local,
                        Some(name.ns.as_ref()),
                        name.prefix.as_deref(),
                    );
                    output.push_str("=\"");
                    escape_html(value, true, output);
                    output.push('"');
                }
                output.push('>');
            }
        }
    }
}

pub struct ParseTask {
    html: String,
    is_document: bool,
    options: Value,
}

#[napi]
impl Task for ParseTask {
    type Output = NativeDocument;
    type JsValue = NativeDocument;

    fn compute(&mut self) -> Result<Self::Output> {
        let _batch = runtime::batch();
        let _permit = runtime::permit()?;
        Ok(NativeDocument::parse_options(
            &self.html,
            self.is_document,
            self.options.clone(),
            None,
        ))
    }

    fn resolve(&mut self, _: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn parse_async(
    html: String,
    is_document: bool,
    options_json: Option<String>,
) -> AsyncTask<ParseTask> {
    let options = options_json
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    AsyncTask::new(ParseTask {
        html,
        is_document,
        options,
    })
}

fn thread_count(requested: Option<u32>, jobs: usize) -> Result<usize> {
    if matches!(requested, Some(0)) || requested.is_some_and(|threads| threads > 1024) {
        return Err(Error::new(
            Status::InvalidArg,
            "threads must be an integer between 1 and 1024",
        ));
    }
    let requested = requested
        .map(|n| n as usize)
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, usize::from));
    Ok(requested.min(jobs.max(1)))
}

pub struct ParseManyTask {
    htmls: Vec<String>,
    is_document: bool,
    threads: usize,
    options: Value,
    /// Extraction plans to run on each root after parsing; with them, each
    /// document also gets its snapshot built on the parsing thread.
    plans: Option<Vec<Value>>,
}

#[napi]
impl Task for ParseManyTask {
    type Output = Vec<NativeDocument>;
    type JsValue = Vec<NativeDocument>;

    fn compute(&mut self) -> Result<Self::Output> {
        runtime::parallel_map(&self.htmls, self.threads, |html| {
            let document =
                NativeDocument::parse_options(html, self.is_document, self.options.clone(), None);
            if let Some(plans) = &self.plans {
                let results = plans
                    .iter()
                    .map(|plan| {
                        let args =
                            serde_json::json!({"ids": [0], "plan": plan, "options": self.options});
                        document.op("extractPlan".into(), args.to_string()).ok()
                    })
                    .collect();
                *document.prepared_plans.borrow_mut() = Some(results);
                // With source locations the snapshot is built from the mutable tree instead.
                if document.source.borrow().is_none() {
                    *document.prepared_snapshot.borrow_mut() = Some(snapshot::build(&document));
                }
            }
            Ok(document)
        })
    }

    fn resolve(&mut self, _: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn parse_many_async(
    htmls: Vec<String>,
    is_document: bool,
    threads: Option<u32>,
    options_json: Option<String>,
    plans_json: Option<String>,
) -> Result<AsyncTask<ParseManyTask>> {
    let threads = thread_count(threads, htmls.len())?;
    let plans = plans_json
        .map(|json| serde_json::from_str(&json).map_err(json_error))
        .transpose()?;
    Ok(AsyncTask::new(ParseManyTask {
        htmls,
        is_document,
        threads,
        options: options_json
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_else(|| serde_json::json!({})),
        plans,
    }))
}

#[napi(object)]
#[derive(Clone)]
pub struct ExtractQuery {
    pub key: String,
    pub selector: String,
    pub attr: Option<String>,
    pub all: Option<bool>,
}

pub struct ExtractManyTask {
    htmls: Vec<String>,
    queries: Vec<ExtractQuery>,
    threads: usize,
    is_document: bool,
    options: Value,
}

#[napi]
impl Task for ExtractManyTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        // Validate before scheduling any documents. Each worker compiles its
        // selectors independently, because selector internals need not be Sync.
        let mut keys = HashSet::new();
        for query in &self.queries {
            // Full selector validation happens through the native selector
            // engine for each document, including jQuery-only pseudo classes.
            if !keys.insert(&query.key) {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("Duplicate extraction key {:?}", query.key),
                ));
            }
        }
        let records: Result<Vec<_>> = runtime::parallel_map(&self.htmls, self.threads, |html| {
            let document =
                NativeDocument::parse_options(html, self.is_document, self.options.clone(), None);
            let mut record = Map::new();
            for query in &self.queries {
                let ids = document.select_ids(&query.selector, None)?;
                let extract = |id| -> Option<Value> {
                    match &query.attr {
                        Some(attr) => document.attribute(id, attr).map(Value::String),
                        None => Some(Value::String(document.text_ids(&[id]))),
                    }
                };
                if query.all.unwrap_or(false) {
                    // Cheerio's map().get() drops absent attribute values.
                    record.insert(
                        query.key.clone(),
                        Value::Array(ids.into_iter().filter_map(extract).collect()),
                    );
                } else if let Some(value) = ids.first().and_then(|id| extract(*id)) {
                    record.insert(query.key.clone(), value);
                }
            }
            Ok(Value::Object(record))
        });
        serde_json::to_string(&records?).map_err(json_error)
    }

    fn resolve(&mut self, _: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn extract_many_async(
    htmls: Vec<String>,
    queries: Vec<ExtractQuery>,
    threads: Option<u32>,
    is_document: Option<bool>,
    options_json: Option<String>,
) -> Result<AsyncTask<ExtractManyTask>> {
    let threads = thread_count(threads, htmls.len())?;
    Ok(AsyncTask::new(ExtractManyTask {
        htmls,
        queries,
        threads,
        is_document: is_document.unwrap_or(true),
        options: options_json
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_else(|| serde_json::json!({})),
    }))
}

#[napi]
pub fn parse_with_tree_adapter(
    env: Env,
    source: String,
    is_document: bool,
    options_json: String,
    bridge: napi::JsFunction,
) -> Result<NativeDocument> {
    hook_sink::parse(env, source, is_document, options_json, bridge)
}

pub struct ExtractPlanTask {
    htmls: Vec<String>,
    plan: Value,
    threads: usize,
    options: Value,
}
#[napi]
impl Task for ExtractPlanTask {
    type Output = String;
    type JsValue = String;
    fn compute(&mut self) -> Result<String> {
        let rows = runtime::parallel_map(&self.htmls, self.threads, |html| {
            let document = NativeDocument::parse_options(html, true, self.options.clone(), None);
            extraction::execute(&document, &self.plan)
        })?;
        serde_json::to_string(&rows).map_err(json_error)
    }
    fn resolve(&mut self, _: Env, output: String) -> Result<String> {
        Ok(output)
    }
}
#[napi]
pub fn extract_plan_many_async(
    htmls: Vec<String>,
    plan_json: String,
    threads: Option<u32>,
    options_json: Option<String>,
) -> Result<AsyncTask<ExtractPlanTask>> {
    let threads = thread_count(threads, htmls.len())?;
    let plan = serde_json::from_str(&plan_json).map_err(json_error)?;
    let options = options_json
        .map(|value| serde_json::from_str(&value))
        .transpose()
        .map_err(json_error)?
        .unwrap_or_else(|| serde_json::json!({}));
    Ok(AsyncTask::new(ExtractPlanTask {
        htmls,
        plan,
        threads,
        options,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attribute_writes_keep_the_parse_tree() {
        let document = NativeDocument::parse(
            "<main><p id='a' class='x'>one</p><svg><use href='#h' xlink:href='#x'/></svg></main>",
            false,
        );
        let ids = document.select_ids("p, use", None).unwrap();
        for (command, args) in [
            (
                "attr",
                serde_json::json!({"ids":ids,"name":"data-k","value":"v"}),
            ),
            ("addClass", serde_json::json!({"ids":ids,"name":"y z"})),
            ("removeClass", serde_json::json!({"ids":ids,"name":"x"})),
            ("removeAttr", serde_json::json!({"ids":ids,"name":"id"})),
        ] {
            document.op(command.into(), args.to_string()).unwrap();
        }
        assert!(document.arena.borrow().is_none());
        assert_eq!(
            document.serialize_nodes(&ids, false),
            "<p class=\"y z\" data-k=\"v\">one</p><use xlink:href=\"#x\" data-k=\"v\" class=\"y z\"></use>"
        );
        assert_eq!(document.select_ids(".z", None).unwrap(), ids);
    }

    #[test]
    fn managed_detached_payloads_are_reclaimed_and_slots_are_reused() {
        let document = NativeDocument::parse("<main></main>", false);
        document.retain(vec![0]);
        let main = document.select_ids("main", None).unwrap()[0];
        document
            .op(
                "clone".into(),
                serde_json::json!({"ids":[main],"deep":false}).to_string(),
            )
            .unwrap();
        assert_eq!(document.collect_garbage().immutable_nodes, 0);
        assert!(document.ids.borrow().is_empty());
        assert!(document.reverse.borrow().is_empty());
        for _ in 0..1000 {
            let id = document
                .create("<p>temporary payload</p>".into(), None, None)
                .unwrap()[0];
            document.retain(vec![id]);
            document.release(vec![id]);
            let stats = document.collect_garbage();
            assert_eq!(stats.live, 2);
            assert!(stats.slots <= 2);
        }
        let held = document
            .create(
                "<section><b>held</b><i>sibling</i></section>".into(),
                None,
                None,
            )
            .unwrap()[0];
        let child = document.select_ids("b", Some(&[held])).unwrap()[0];
        document.retain(vec![child]);
        document.release(vec![0]);
        document.collect_garbage();
        assert_eq!(document.text_ids(&[held]), "heldsibling");
        assert!(document.arena.borrow().as_ref().unwrap().node(0).is_none());
        document.release(vec![child]);
        assert_eq!(document.collect_garbage().live, 0);
    }

    #[test]
    fn adopting_pinned_nodes_transfers_ownership_without_retaining_source_payloads() {
        let source = NativeDocument::parse("<p><b>move</b></p><aside>stay</aside>", false);
        let target = NativeDocument::parse("<main></main>", false);
        source.retain(vec![0]);
        target.retain(vec![0]);
        let p = source.select_ids("p", None).unwrap()[0];
        let b = source.select_ids("b", None).unwrap()[0];
        source.retain(vec![b]);
        let result: Value =
            serde_json::from_str(&target.adopt(&source, vec![p], None).unwrap()).unwrap();
        let mapping: Vec<[u32; 2]> = serde_json::from_value(result["mapping"].clone()).unwrap();
        let moved_b = mapping.iter().find(|pair| pair[0] == b).unwrap()[1];
        source.collect_garbage();
        target.collect_garbage();
        assert_eq!(target.text_ids(&[moved_b]), "move");
        assert!(!source.retained.borrow().contains_key(&b));
        assert_eq!(target.retained.borrow().get(&moved_b), Some(&1));
        target.release(vec![moved_b]);
        target.collect_garbage();
        assert_eq!(target.collect_garbage().live, 2);
    }

    #[test]
    fn text_comment_doctype_locations_include_entities_and_foster_parenting() {
        let source = "<!doctype html><p>A&amp;B<!--c-->😀</p><table>A<tr><td>B</td></tr>C</table>";
        let document = NativeDocument::parse_options(
            source,
            true,
            serde_json::json!({"sourceCodeLocationInfo":true}),
            None,
        );
        document.ensure_arena().unwrap();
        let arena = document.arena.borrow();
        let nodes = &arena.as_ref().unwrap().nodes;
        let location = |data: &str| {
            nodes
                .iter()
                .find(|node| node.data.as_deref() == Some(data))
                .unwrap()
                .extras
                .get("sourceCodeLocation")
                .cloned()
                .unwrap()
        };
        assert_eq!(location("A&B")["startOffset"], 18);
        assert_eq!(location("A&B")["endOffset"], 25);
        assert_eq!(location("c")["startOffset"], 25);
        assert_eq!(location("c")["endOffset"], 33);
        assert_eq!(location("😀")["startOffset"], 33);
        assert_eq!(location("😀")["endOffset"], 35);
        let foster = location("AC");
        assert_eq!(foster["startOffset"], 46);
        assert_eq!(foster["endOffset"], 67);
        let html = nodes
            .iter()
            .find(|node| node.name.as_deref() == Some("html"))
            .unwrap();
        assert_eq!(html.extras.get("sourceCodeLocation"), Some(&Value::Null));
    }

    #[test]
    fn htmlparser2_cdata_and_xml_element_types_match_parser_options() {
        let xml = NativeDocument::parse_options(
            "<script>x</script><style>y</style>",
            true,
            serde_json::json!({"xmlMode":true}),
            None,
        );
        xml.ensure_arena().unwrap();
        assert!(xml
            .arena
            .borrow()
            .as_ref()
            .unwrap()
            .nodes
            .iter()
            .filter(|node| node.name.is_some())
            .all(|node| node.kind == "tag"));
        for (options, expected) in [
            (
                serde_json::json!({"_useHtmlParser2":true}),
                "<root><!--[CDATA[x<y]]--></root>",
            ),
            (
                serde_json::json!({"_useHtmlParser2":true,"recognizeCDATA":true}),
                "<root><![CDATA[x<y]]></root>",
            ),
            (
                serde_json::json!({"xmlMode":true}),
                "<root><![CDATA[x<y]]></root>",
            ),
        ] {
            assert_eq!(
                NativeDocument::parse_options("<root><![CDATA[x<y]]></root>", true, options, None)
                    .outer_html(vec![0]),
                expected
            );
        }
    }

    #[test]
    fn live_token_locations_do_not_reuse_ignored_identical_whitespace() {
        let source =
            "\n<html>\n<head></head>\n<body>\n<p a=one b=\"two\" c>Text</p>\n</body></html>";
        let document = NativeDocument::parse_options(
            source,
            true,
            serde_json::json!({"sourceCodeLocationInfo":true}),
            None,
        );
        document.ensure_arena().unwrap();
        let arena = document.arena.borrow();
        let arena = arena.as_ref().unwrap();
        let body = arena
            .nodes
            .iter()
            .find(|node| node.name.as_deref() == Some("body"))
            .unwrap();
        let first = arena.node(body.children[0]).unwrap();
        assert_eq!(first.data.as_deref(), Some("\n"));
        assert_eq!(first.extras["sourceCodeLocation"]["startOffset"], 28);
        let p = arena
            .nodes
            .iter()
            .find(|node| node.name.as_deref() == Some("p"))
            .unwrap();
        assert_eq!(
            p.extras["sourceCodeLocation"]["attrs"]["a"]["startOffset"],
            32
        );
        assert_eq!(
            p.extras["sourceCodeLocation"]["attrs"]["a"]["endOffset"],
            37
        );
    }

    #[test]
    fn reconstructed_formatting_and_template_fragments_keep_native_source_locations() {
        let document = NativeDocument::parse_options(
            "<p><b>A</p>B",
            true,
            serde_json::json!({"sourceCodeLocationInfo":true}),
            None,
        );
        document.ensure_arena().unwrap();
        let records = document.arena.borrow();
        let locations: Vec<_> = records
            .as_ref()
            .unwrap()
            .nodes
            .iter()
            .filter(|node| node.name.as_deref() == Some("b"))
            .map(|node| node.extras["sourceCodeLocation"].clone())
            .collect();
        assert_eq!(locations.len(), 2);
        assert_eq!(locations[0]["startOffset"], 3);
        assert_eq!(locations[0]["endOffset"], 7);
        assert_eq!(locations[1]["startOffset"], 3);
        assert_eq!(locations[1]["endOffset"], 12);
        let template = NativeDocument::parse_options(
            "<template><p>T</template>",
            true,
            serde_json::json!({"sourceCodeLocationInfo":true}),
            None,
        );
        template.ensure_arena().unwrap();
        let records = template.arena.borrow();
        let fragment = records
            .as_ref()
            .unwrap()
            .nodes
            .iter()
            .find(|node| node.kind == "root" && node.parent.is_some())
            .unwrap();
        assert_eq!(
            fragment.extras.get("sourceCodeLocation"),
            Some(&Value::Null)
        );
    }

    #[test]
    fn fragment_root_and_html_serialization() {
        let document = NativeDocument::parse("hello &amp; <b z='x' a='y'>world</b>", false);
        assert_eq!(document.element_ids().len(), 1);
        assert_eq!(
            document.outer_html(vec![0]),
            "hello &amp; <b z=\"x\" a=\"y\">world</b>"
        );
        assert_eq!(document.text(vec![0]), "hello & world");
        let table_fragment = NativeDocument::parse("<td>A</td><td>B</td>", false);
        assert_eq!(table_fragment.outer_html(vec![0]), "<td>A</td><td>B</td>");
    }

    #[test]
    fn raw_text_and_html5_recovery() {
        let document = NativeDocument::parse(
            "<title>A &amp; B</title><script>1 < 2 && 3 > 0</script><p>one<p>two",
            true,
        );
        assert_eq!(document.select_ids("p", None).unwrap().len(), 2);
        let script = document.select_ids("script", None).unwrap();
        assert_eq!(document.text_ids(&script), "1 < 2 && 3 > 0");
        assert_eq!(document.inner_html(script[0]), "1 < 2 && 3 > 0");
    }

    #[test]
    fn selector_contexts_and_document_order() {
        let document = NativeDocument::parse(
            "<table>outside<tr><td>A</table><div><p class='x'>B</p><p>C</p></div>",
            false,
        );
        let div = document.select_ids("div", None).unwrap();
        assert_eq!(document.select_ids("p", Some(&div)).unwrap().len(), 2);
        assert_eq!(document.select_ids("div", Some(&div)).unwrap().len(), 0);
        let nodes = document.select_ids("*", None).unwrap();
        assert!(nodes.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn export_includes_template_fragments_and_doctype() {
        let document = NativeDocument::parse("<!DOCTYPE html><template><p>x</p></template>", true);
        let records: Value = serde_json::from_str(&document.export_tree().unwrap()).unwrap();
        assert_eq!(records[1]["x-name"], "html");
        let template = document.select_ids("template", None).unwrap()[0];
        let fragment = records[template as usize]["children"][0].as_u64().unwrap() as usize;
        assert_eq!(records[fragment]["type"], "root");
        assert_eq!(document.select_ids("p", None).unwrap().len(), 1);
        assert_eq!(
            document.select_ids("p", Some(&[template])).unwrap().len(),
            0
        );
    }

    #[test]
    fn native_documents_can_move_to_worker_threads() {
        fn assert_send<T: Send>() {}
        assert_send::<NativeDocument>();
    }

    #[test]
    fn unicode_bom_and_mathml_integration_points() {
        for is_document in [true, false] {
            let document = NativeDocument::parse("\u{feff}<h1>UTF8</h1>", is_document);
            assert_eq!(document.text(vec![0]), "\u{feff}UTF8");
            let document = NativeDocument::parse("<math><annotation-xml encoding='text/html'><div>HTML</div></annotation-xml></math>", is_document);
            assert_eq!(
                document
                    .select_ids("annotation-xml > div", None)
                    .unwrap()
                    .len(),
                1
            );
            assert!(document.outer_html(vec![0]).contains(
                "<annotation-xml encoding=\"text/html\"><div>HTML</div></annotation-xml>"
            ));
        }
    }

    #[test]
    fn foreign_attributes_match_the_cheerio_dom_adapter() {
        for (attrs, expected_html, expected_href) in [
            (
                "href='plain' xlink:href='linked'",
                "xlink:href=\"linked\"",
                "linked",
            ),
            (
                "xlink:href='linked' href='plain'",
                "href=\"plain\"",
                "plain",
            ),
        ] {
            let document = NativeDocument::parse(&format!("<svg><a {attrs}>x</a></svg>"), false);
            let ids = document.select_ids("[href]", None).unwrap();
            assert_eq!(ids.len(), 1);
            assert_eq!(
                document.attribute(ids[0], "href").as_deref(),
                Some(expected_href)
            );
            assert_eq!(
                document.outer_html(vec![0]),
                format!("<svg><a {expected_html}>x</a></svg>")
            );
            let mut task = ExtractManyTask {
                htmls: vec![format!("<svg><a {attrs}>x</a></svg>")],
                queries: vec![ExtractQuery {
                    key: "href".into(),
                    selector: "[href]".into(),
                    attr: Some("href".into()),
                    all: None,
                }],
                threads: 1,
                is_document: true,
                options: serde_json::json!({}),
            };
            let result: Value = serde_json::from_str(&task.compute().unwrap()).unwrap();
            assert_eq!(result[0]["href"], expected_href);
        }
    }

    #[test]
    fn attribute_namespace_scanner_respects_css_syntax() {
        for (source, expected) in [
            ("a[href][lang|=en]", "a[*|href][*|lang|=en]"),
            (
                "a[*|href][xlink|href][|href]",
                "a[*|href][xlink|href][|href]",
            ),
            (
                "[title='[quoted]'][data-x=\"x\\\"[y]\"]",
                "[*|title='[quoted]'][*|data-x=\"x\\\"[y]\"]",
            ),
            ("#a\\[b[data\\|name]", "#a\\[b[*|data\\|name]"),
            ("[ href = 'x' ]", "[ *|href = 'x' ]"),
        ] {
            assert_eq!(normalize_attribute_namespaces(source), expected);
        }
    }

    #[test]
    fn export_document_mode_omits_fragment_metadata() {
        for (source, mode) in [
            ("<p>x", "quirks"),
            ("<!doctype html><p>x", "no-quirks"),
            ("<!doctype html public '-//W3C//DTD XHTML 1.0 Transitional//EN' 'http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd'><p>x", "limited-quirks"),
        ] {
            let document: Value = serde_json::from_str(&NativeDocument::parse(source, true).export_tree().unwrap()).unwrap();
            assert_eq!(document[0]["x-mode"], mode);
            let fragment: Value = serde_json::from_str(&NativeDocument::parse(source, false).export_tree().unwrap()).unwrap();
            assert!(fragment[0].get("x-mode").is_none());
        }
    }

    #[test]
    fn native_mutations_preserve_ids_and_query_live_tree() {
        let document = NativeDocument::parse("<ul><li>A</li><li>B</li></ul>", false);
        let ul = document.select_ids("ul", None).unwrap()[0];
        let first = document.select_ids("li", None).unwrap()[0];
        document
            .op(
                "text".into(),
                serde_json::json!({"ids":[first],"value":"changed"}).to_string(),
            )
            .unwrap();
        assert_eq!(document.text_ids(&[first]), "changed");
        let added = document
            .create("<li>C</li>".into(), Some(ul), None)
            .unwrap();
        document
            .op(
                "insert".into(),
                serde_json::json!({"targetIds":[ul],"nodeIds":added,"position":"append"})
                    .to_string(),
            )
            .unwrap();
        assert_eq!(document.select_ids("li", None).unwrap().len(), 3);
        assert_eq!(document.select_ids("li:first", None).unwrap(), vec![first]);
        assert_eq!(
            document.outer_html(vec![ul]),
            "<ul><li>changed</li><li>B</li><li>C</li></ul>"
        );
        document
            .op(
                "insert".into(),
                serde_json::json!({"targetIds":[first],"nodeIds":[first],"position":"replace"})
                    .to_string(),
            )
            .unwrap();
        assert_eq!(document.select_ids("li", None).unwrap().len(), 3);
        let detached = document
            .create("<div>detached</div>".into(), None, None)
            .unwrap()[0];
        let sorted = document
            .op(
                "uniqueSort".into(),
                serde_json::json!({"ids":[detached,ul,detached]}).to_string(),
            )
            .unwrap();
        // As domutils does: the last of repeated ids is kept, and nodes of
        // separate trees keep their order.
        assert_eq!(
            serde_json::from_str::<Vec<u32>>(&sorted).unwrap(),
            vec![ul, detached]
        );
    }

    #[test]
    fn batched_moves_preserve_sibling_order_and_last_duplicate_position() {
        let document = NativeDocument::parse(
            "<div><i id='a'></i><i id='b'></i><i id='c'></i></div>",
            false,
        );
        let parent = document.select_ids("div", None).unwrap()[0];
        let ids = document.select_ids("i", None).unwrap();
        let (a, b, c) = (ids[0], ids[1], ids[2]);
        document
            .op(
                "insert".into(),
                serde_json::json!({"targetIds":[b],"nodeIds":[c,a],"position":"before"})
                    .to_string(),
            )
            .unwrap();
        assert_eq!(document.select_ids("i", None).unwrap(), vec![c, a, b]);
        document
            .op(
                "insert".into(),
                serde_json::json!({"targetIds":[parent],"nodeIds":[c,b,c],"position":"append"})
                    .to_string(),
            )
            .unwrap();
        assert_eq!(document.select_ids("i", None).unwrap(), vec![a, b, c]);
        document
            .op(
                "remove".into(),
                serde_json::json!({"ids":[a,c]}).to_string(),
            )
            .unwrap();
        let node: Value = serde_json::from_str(&document.node(b).unwrap()).unwrap();
        assert!(node["prev"].is_null());
        assert!(node["next"].is_null());
        assert_eq!(document.select_ids("i", None).unwrap(), vec![b]);
    }

    #[test]
    fn jquery_numeric_ids_recover_from_browser_css_parse_restrictions() {
        let document = NativeDocument::parse("<a id='1'>First</a><a id='2'>Second</a>", false);
        let selected = document.select_ids("#1", None).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(document.text_ids(&selected), "First");
    }

    #[test]
    fn cloning_nodes_drops_api_data_caches() {
        let document = NativeDocument::parse("<p data-from-attribute='value'>x</p>", false);
        let id = document.select_ids("p", None).unwrap()[0];
        document
            .op(
                "data".into(),
                serde_json::json!({"ids":[id],"name":"cacheOnly","value":"cached"}).to_string(),
            )
            .unwrap();
        let clone: Vec<u32> = serde_json::from_str(
            &document
                .op("clone".into(), serde_json::json!({"ids":[id]}).to_string())
                .unwrap(),
        )
        .unwrap();
        let data: Value = serde_json::from_str(
            &document
                .op(
                    "data".into(),
                    serde_json::json!({"ids":clone,"name":"cacheOnly"}).to_string(),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(data["found"], false);
    }

    #[test]
    fn adopting_branches_between_native_documents_detaches_the_source() {
        let target = NativeDocument::parse("<div></div>", false);
        let source = NativeDocument::parse("<p><b>moved</b></p><span>kept</span>", false);
        let id = source.select_ids("p", None).unwrap()[0];
        source
            .op(
                "data".into(),
                serde_json::json!({"ids":[id],"name":"cache","value":{"preserved":true}})
                    .to_string(),
            )
            .unwrap();
        let adopted: Value =
            serde_json::from_str(&target.adopt(&source, vec![id], None).unwrap()).unwrap();
        let roots = arena::value_ids(&adopted["roots"]);
        let div = target.select_ids("div", None).unwrap()[0];
        target
            .op(
                "insert".into(),
                serde_json::json!({"targetIds":[div],"nodeIds":roots,"position":"append"})
                    .to_string(),
            )
            .unwrap();
        assert_eq!(source.outer_html(vec![0]), "<span>kept</span>");
        assert_eq!(target.outer_html(vec![0]), "<div><p><b>moved</b></p></div>");
        assert_eq!(adopted["mapping"].as_array().unwrap().len(), 3);
        let data: Value = serde_json::from_str(
            &target
                .op(
                    "data".into(),
                    serde_json::json!({"ids":roots,"name":"cache"}).to_string(),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(data["value"]["preserved"], true);
        let source = NativeDocument::parse("<p><b>nested</b></p>", false);
        let ids = source.select_ids("p,b", None).unwrap();
        let adopted: Value =
            serde_json::from_str(&target.adopt(&source, ids, None).unwrap()).unwrap();
        let roots = arena::value_ids(&adopted["roots"]);
        assert_eq!(target.outer_html(roots), "<p></p><b>nested</b>");
        assert_eq!(adopted["mapping"].as_array().unwrap().len(), 3);
        let source = NativeDocument::parse("<em>copied</em>", false);
        let id = source.select_ids("em", None).unwrap()[0];
        target.adopt(&source, vec![id], Some(false)).unwrap();
        assert_eq!(source.outer_html(vec![0]), "<em>copied</em>");
        let xml = NativeDocument::parse_options(
            "<Item ID='case'>XML</Item>",
            true,
            serde_json::json!({"xml":true}),
            None,
        );
        let ids = xml.select_ids("Item", None).unwrap();
        let adopted: Value = serde_json::from_str(&target.adopt(&xml, ids, None).unwrap()).unwrap();
        let roots = arena::value_ids(&adopted["roots"]);
        let matched: Vec<u32> = serde_json::from_str(
            &target
                .op(
                    "matches".into(),
                    serde_json::json!({"ids":roots,"selector":"Item","options":{"xmlMode":true}})
                        .to_string(),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(matched.len(), 1);
    }

    #[test]
    fn per_operation_selection_options_restore_after_success_and_errors() {
        let document = NativeDocument::parse("<input checked><a href='/path'>link</a>", false);
        let input = document.select_ids("input", None).unwrap()[0];
        let xml = document
            .op(
                "attr".into(),
                serde_json::json!({"ids":[input],"name":"checked","options":{"xmlMode":true}})
                    .to_string(),
            )
            .unwrap();
        assert_eq!(xml, "\"\"");
        assert!(document
            .op(
                "matches".into(),
                serde_json::json!({"ids":[input],"selector":":unknown","options":{"xmlMode":true}})
                    .to_string()
            )
            .is_err());
        let html = document
            .op(
                "attr".into(),
                serde_json::json!({"ids":[input],"name":"checked"}).to_string(),
            )
            .unwrap();
        assert_eq!(html, "\"checked\"");
    }

    #[test]
    fn native_xml_preserves_case_cdata_and_decoding_options() {
        let document = NativeDocument::parse_options(
            "<?xml version='1.0'?><Root><Item ID='x'>&amp;<![CDATA[a<b]]></Item><Empty/></Root>",
            true,
            serde_json::json!({"xml":true}),
            None,
        );
        let item = document.select_ids("Item", None).unwrap();
        assert_eq!(item.len(), 1);
        assert_eq!(document.attribute(item[0], "ID").as_deref(), Some("x"));
        assert_eq!(document.text_ids(&item), "&a<b");
        assert_eq!(document.select_ids("item", None).unwrap().len(), 0);
        assert!(document
            .outer_html(vec![0])
            .contains("<Item ID=\"x\">&amp;<![CDATA[a<b]]></Item><Empty/>"));
        let raw = NativeDocument::parse_options(
            "<tag>&amp;</tag>",
            true,
            serde_json::json!({"xml":{"decodeEntities":false}}),
            None,
        );
        assert_eq!(raw.text_ids(&[0]), "&amp;");
        assert_eq!(raw.outer_html(vec![0]), "<tag>&amp;</tag>");
    }

    #[test]
    fn htmlparser_mode_preserves_raw_text_and_implied_closing_rules() {
        for (source, expected) in [
            (
                "<script>if(a < b) value = \"&amp;\";</script>",
                "<script>if(a < b) value = \"&amp;\";</script>",
            ),
            ("<p>A<p>B", "<p>A</p><p>B</p>"),
            (
                "<textarea>&lt;b&gt; &amp;</textarea>",
                "<textarea>&amp;lt;b&amp;gt; &amp;amp;</textarea>",
            ),
            ("<div/>A", "<div>A</div>"),
            (
                "<title>&lt;b&gt; &amp;</title>",
                "<title>&lt;b&gt; &amp;</title>",
            ),
            ("a < 2", "a &lt; 2"),
        ] {
            let document = NativeDocument::parse_options(
                source,
                true,
                serde_json::json!({"xml":{"xmlMode":false}}),
                None,
            );
            assert_eq!(document.outer_html(vec![0]), expected, "{source}");
        }
        let document = NativeDocument::parse_options(
            "<div/>A",
            true,
            serde_json::json!({"xml":{"xmlMode":false,"recognizeSelfClosing":true}}),
            None,
        );
        assert_eq!(document.outer_html(vec![0]), "<div></div>A");
    }

    #[test]
    fn native_html_source_locations_use_utf16_offsets() {
        let source = "<div id='x'>😀<span>x</span></div>";
        let document = NativeDocument::parse_options(
            source,
            false,
            serde_json::json!({"sourceCodeLocationInfo":true}),
            None,
        );
        let span = document.select_ids("span", None).unwrap()[0];
        let node: Value = serde_json::from_str(&document.node(span).unwrap()).unwrap();
        assert_eq!(node["sourceCodeLocation"]["startOffset"], 14);
        assert_eq!(node["sourceCodeLocation"]["endOffset"], 28);
        assert_eq!(node["sourceCodeLocation"]["startTag"]["endOffset"], 20);
    }
}
