//! Evaluate callback-free extraction maps on native worker threads.

use napi::bindgen_prelude::*;
use serde_json::{json, Map, Value};

use crate::NativeDocument;

fn invalid(message: &str) -> Error {
    Error::new(Status::InvalidArg, message.to_owned())
}

fn entries(value: &Value) -> Result<&[Value]> {
    value
        .get("entries")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| invalid("Extraction plan requires entries"))
}

fn extract(
    document: &NativeDocument,
    plan: &[Value],
    contexts: Option<&[u32]>,
    depth: usize,
) -> Result<Value> {
    if depth > 64 {
        return Err(invalid("Extraction plan nesting exceeds 64 levels"));
    }
    let mut result = Map::new();
    for entry in plan {
        let key = entry
            .get("key")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("Extraction entry requires a key"))?;
        let selector = entry
            .get("selector")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("Extraction entry requires a selector"))?;
        let all = entry.get("all").and_then(Value::as_bool).unwrap_or(false);
        let value = entry
            .get("value")
            .ok_or_else(|| invalid("Extraction entry requires a value"))?;
        let ids = document.select_ids(selector, contexts)?;
        let read = |id: u32| -> Result<Value> {
            match value.get("kind").and_then(Value::as_str) {
                Some("map") => extract(document, entries(value)?, Some(&[id]), depth + 1),
                Some("property") => {
                    let name = value
                        .get("name")
                        .and_then(Value::as_str)
                        .ok_or_else(|| invalid("Extraction property requires a name"))?;
                    if name == "textContent" {
                        return Ok(Value::String(document.text_ids(&[id])));
                    }
                    if matches!(name, "id" | "class" | "title" | "alt")
                        || name.starts_with("data-")
                        || name.starts_with("aria-")
                        || matches!(name, "href" | "src")
                            && document.options.get("baseURI").is_none()
                    {
                        return Ok(document
                            .attribute(id, name)
                            .map(Value::String)
                            .unwrap_or(Value::Null));
                    }
                    document.ensure_arena()?;
                    let mut arena = document.arena_for_write();
                    let arena = arena
                        .as_mut()
                        .ok_or_else(|| invalid("Missing native document arena"))?;
                    if matches!(name, "name" | "type" | "nodeType") {
                        return Ok(match arena.node(id) {
                            Some(node) if name == "name" => {
                                node.name.clone().map(Value::String).unwrap_or(Value::Null)
                            }
                            Some(node) if name == "type" => Value::String(node.kind.to_string()),
                            Some(_) => json!(1),
                            None => Value::Null,
                        });
                    }
                    crate::attributes::execute(
                        arena,
                        "prop",
                        &json!({ "ids": [id], "name": name }),
                    )?
                    .ok_or_else(|| invalid("Unsupported extraction property"))
                }
                _ => Err(invalid("Unknown extraction value kind")),
            }
        };
        if all {
            let mut values = Vec::new();
            for id in ids {
                match read(id)? {
                    Value::Null => {}
                    Value::Array(items) => values.extend(items),
                    item => values.push(item),
                }
            }
            result.insert(key.into(), Value::Array(values));
        } else if let Some(id) = ids.first() {
            let item = read(*id)?;
            if !item.is_null() {
                result.insert(key.into(), item);
            }
        }
    }
    Ok(Value::Object(result))
}

pub(crate) fn execute(document: &NativeDocument, plan: &Value) -> Result<Value> {
    if plan.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(invalid("Unsupported extraction plan version"));
    }
    extract(document, entries(plan)?, None, 0)
}

/// Extracts relative to `contexts`, reading the parse tree while it is unchanged.
pub(crate) fn execute_in(
    document: &NativeDocument,
    plan: &Value,
    contexts: &[u32],
) -> Result<Value> {
    if plan.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(invalid("Unsupported extraction plan version"));
    }
    extract(document, entries(plan)?, Some(contexts), 0)
}

fn extract_arena(
    arena: &mut crate::arena::DomArena,
    plan: &[Value],
    contexts: &[u32],
    depth: usize,
) -> Result<Value> {
    if depth > 64 {
        return Err(invalid("Extraction plan nesting exceeds 64 levels"));
    }
    let mut result = Map::new();
    for entry in plan {
        let key = entry
            .get("key")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("Extraction entry requires a key"))?;
        let selector = entry
            .get("selector")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("Extraction entry requires a selector"))?;
        let all = entry.get("all").and_then(Value::as_bool).unwrap_or(false);
        let value = entry
            .get("value")
            .ok_or_else(|| invalid("Extraction entry requires a value"))?;
        let ids = crate::selector::select(arena, selector, Some(contexts))?;
        let mut read = |id| -> Result<Value> {
            match value.get("kind").and_then(Value::as_str) {
                Some("map") => extract_arena(arena, entries(value)?, &[id], depth + 1),
                Some("property") => {
                    let name = value
                        .get("name")
                        .and_then(Value::as_str)
                        .ok_or_else(|| invalid("Extraction property requires a name"))?;
                    if matches!(name, "name" | "type" | "nodeType") {
                        return Ok(match arena.node(id) {
                            Some(node) if name == "name" => {
                                node.name.clone().map(Value::String).unwrap_or(Value::Null)
                            }
                            Some(node) if name == "type" => Value::String(node.kind.to_string()),
                            Some(_) => json!(1),
                            None => Value::Null,
                        });
                    }
                    crate::attributes::execute(arena, "prop", &json!({"ids":[id],"name":name}))?
                        .ok_or_else(|| invalid("Unsupported extraction property"))
                }
                _ => Err(invalid("Unknown extraction value kind")),
            }
        };
        if all {
            let mut values = Vec::new();
            for id in ids {
                match read(id)? {
                    Value::Null => {}
                    Value::Array(items) => values.extend(items),
                    value => values.push(value),
                }
            }
            result.insert(key.into(), Value::Array(values));
        } else if let Some(id) = ids.first() {
            let value = read(*id)?;
            if !value.is_null() {
                result.insert(key.into(), value);
            }
        }
    }
    Ok(Value::Object(result))
}

/** Use the caller's active options and contexts for pure prefixes around callbacks. */
pub(crate) fn execute_arena(
    arena: &mut crate::arena::DomArena,
    plan: &Value,
    contexts: &[u32],
) -> Result<Value> {
    if plan.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(invalid("Unsupported extraction plan version"));
    }
    extract_arena(arena, entries(plan)?, contexts, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_maps_preserve_native_property_and_missing_value_semantics() {
        let document = NativeDocument::parse_options(
            "<section><a href='/page'>A<b>B</b></a><input checked></section><section><p>C</p></section>",
            true,
            json!({ "baseURI": "https://example.test/base/" }),
            None,
        );
        let plan = json!({"version":1,"entries":[
            {"key":"rows","selector":"section","all":true,"value":{"kind":"map","entries":[
                {"key":"link","selector":"a","all":false,"value":{"kind":"property","name":"href"}},
                {"key":"content","selector":"a","all":false,"value":{"kind":"property","name":"innerHTML"}},
                {"key":"checked","selector":"input","all":true,"value":{"kind":"property","name":"checked"}},
                {"key":"missing","selector":".absent","all":false,"value":{"kind":"property","name":"textContent"}}
            ]}}
        ]});
        assert_eq!(
            execute(&document, &plan).unwrap(),
            json!({"rows":[
                {"link":"https://example.test/page","content":"A<b>B</b>","checked":[true]},
                {"checked":[]}
            ]})
        );
    }
}
