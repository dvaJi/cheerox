//! Cheerio attribute, property, style, data, class and form semantics.
//! JavaScript only supplies callbacks and preserves opaque JS value identities.
use crate::arena::{value_ids, DomArena};
use crate::codec;
use serde_json::{json, Map, Number, Value};
use std::collections::HashSet;

fn element(arena: &DomArena, id: u32) -> bool {
    arena.node(id).is_some_and(|node| node.is_element())
}

fn boolean_attribute(name: &str) -> bool {
    matches!(
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
    )
}

fn js_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Null => "null".into(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(value)
            if value.get("__undefinedJavaScriptValue") == Some(&Value::Bool(true)) =>
        {
            "undefined".into()
        }
        Value::Object(_) => "[object Object]".into(),
        Value::Number(number) => number
            .as_f64()
            .map(js_number)
            .unwrap_or_else(|| number.to_string()),
        Value::Bool(value) => value.to_string(),
    }
}

fn js_number(number: f64) -> String {
    if number == 0.0 {
        return "0".into();
    }
    if number.abs() >= 1e21 || number.abs() < 1e-6 {
        let scientific = format!("{number:e}");
        if let Some((mantissa, exponent)) = scientific.split_once('e') {
            if let Ok(exponent) = exponent.parse::<i32>() {
                return format!(
                    "{mantissa}e{}{exponent}",
                    if exponent >= 0 { "+" } else { "" }
                );
            }
        }
        scientific
    } else {
        number.to_string()
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.is_empty(),
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        _ => true,
    }
}

fn get_attr(arena: &DomArena, id: u32, name: &str) -> Value {
    let Some(node) = arena.node(id).filter(|node| node.is_element()) else {
        return Value::Null;
    };
    if name.is_empty() {
        return Value::Object(node.attribs.to_map());
    }
    if let Some(value) = node.attribs.get(name) {
        return if !arena.xml_mode() && boolean_attribute(name) {
            json!(name)
        } else {
            value.clone()
        };
    }
    if name == "value" {
        if node.name.as_deref() == Some("option") {
            return json!(arena.text(&node.children));
        }
        if node.name.as_deref() == Some("input")
            && matches!(arena.attr(id, "type"), Some("radio" | "checkbox"))
        {
            return json!("on");
        }
    }
    Value::Null
}

fn inner_text(arena: &DomArena, id: u32) -> String {
    let mut output = String::new();
    let mut stack = vec![id];
    let mut seen = HashSet::new();
    while let Some(id) = stack.pop() {
        if !seen.insert(id) {
            continue;
        }
        let Some(node) = arena.node(id) else {
            continue;
        };
        if matches!(node.name.as_deref(), Some("script" | "style")) || node.kind == "comment" {
            continue;
        }
        if node.kind == "text" {
            output.push_str(node.data.as_deref().unwrap_or(""));
        } else if node.name.as_deref() == Some("br") {
            output.push('\n');
        } else {
            stack.extend(node.children.iter().rev().copied());
        }
    }
    output
}

fn parse_css(style: &str) -> Map<String, Value> {
    let mut properties = Map::new();
    let mut previous: Option<String> = None;
    for segment in style.trim().split(';') {
        let colon = segment.find(':');
        if colon.is_none_or(|index| index == 0 || index + 1 == segment.len()) {
            let continuation = segment.trim_end();
            if !continuation.is_empty() {
                if let Some(key) = &previous {
                    let mut value = properties.get(key).map(js_string).unwrap_or_default();
                    value.push(';');
                    value.push_str(continuation);
                    properties.insert(key.clone(), json!(value));
                }
            }
        } else if let Some(colon) = colon {
            let key = segment[..colon].trim().to_owned();
            let value = segment[colon + 1..].trim();
            properties.insert(key.clone(), json!(value));
            previous = Some(key);
        }
    }
    properties
}

fn set_css(arena: &mut DomArena, ids: &[u32], name: &str, value: &Value) {
    for id in ids {
        if !element(arena, *id) {
            continue;
        }
        let mut properties = parse_css(arena.attr(*id, "style").unwrap_or(""));
        if value.as_str() == Some("") {
            properties.shift_remove(name);
        } else if !value.is_null() {
            properties.insert(name.into(), json!(js_string(value)));
        }
        let style = properties
            .iter()
            .map(|(key, value)| format!("{key}: {};", js_string(value)))
            .collect::<Vec<_>>()
            .join(" ");
        arena.set_attr(&[*id], "style", Some(&style));
    }
}

fn node_property(arena: &DomArena, id: u32, name: &str) -> bool {
    matches!(
        name,
        "attribs"
            | "children"
            | "childNodes"
            | "parent"
            | "parentNode"
            | "prev"
            | "previousSibling"
            | "next"
            | "nextSibling"
            | "firstChild"
            | "lastChild"
            | "nodeType"
            | "nodeValue"
            | "name"
            | "tagName"
            | "type"
            | "startIndex"
            | "endIndex"
    ) || arena.node(id).is_some_and(|node| {
        node.extras.contains_key(name)
            || match name {
                "namespace" => node.namespace.is_some(),
                "attribsNamespace" => node.attribs_namespace.is_some(),
                "attribsPrefix" => node.attribs_prefix.is_some(),
                _ => false,
            }
    })
}

fn get_prop(arena: &mut DomArena, id: u32, name: &str) -> napi::Result<Value> {
    let Some(node) = arena.node(id) else {
        return Ok(Value::Null);
    };
    Ok(match name {
        "style" if node.is_element() => {
            let mut properties = parse_css(arena.attr(id, "style").unwrap_or(""));
            let names: Vec<_> = properties.keys().cloned().collect();
            for (index, name) in names.iter().enumerate() {
                properties.insert(index.to_string(), json!(name));
            }
            properties.insert("length".into(), json!(names.len()));
            Value::Object(properties)
        }
        "tagName" | "nodeName" if node.is_element() => {
            json!(node.name.as_deref().unwrap_or("").to_uppercase())
        }
        "textContent" => json!(arena.text(&[id])),
        "innerText" => json!(if arena.xml_mode() {
            arena.text(&[id])
        } else {
            inner_text(arena, id)
        }),
        "outerHTML" => json!(arena.serialize_mut(&[id], &arena.options.clone())),
        "innerHTML" => json!(arena.inner_html_mut(id)),
        "href" | "src" if node.is_element() => {
            let value = arena.attr(id, name);
            let tag = node.name.as_deref().unwrap_or("");
            let resolves = name == "href" && matches!(tag, "a" | "link")
                || name == "src" && matches!(tag, "img" | "iframe" | "audio" | "video" | "source");
            match (value, arena.options.get("baseURI").and_then(Value::as_str)) {
                (Some(value), Some(base)) if resolves => json!(crate::codec::encode_literal(
                    url::Url::parse(&crate::codec::to_usv(base))
                        .and_then(|base| base.join(&crate::codec::to_usv(value)))
                        .map_err(|error| napi::Error::from_reason(error.to_string()))?
                        .as_str()
                )),
                (Some(value), _) => json!(value),
                _ => Value::Null,
            }
        }
        _ if !node.is_element() => Value::Null,
        _ if node_property(arena, id, name) => json!({"__nativeNodeProperty": name}),
        _ if !arena.xml_mode() && boolean_attribute(name) => json!(node.attribs.contains_key(name)),
        _ => get_attr(arena, id, name),
    })
}

fn set_prop(arena: &mut DomArena, ids: &[u32], name: &str, value: &Value) -> napi::Result<()> {
    for id in ids {
        if !element(arena, *id) {
            continue;
        }
        if node_property(arena, *id, name) || matches!(name, "namespace" | "prefix") {
            let field = match name {
                "childNodes" => "children",
                "parentNode" => "parent",
                "previousSibling" => "prev",
                "nextSibling" => "next",
                _ => name,
            };
            arena.set_node(*id, field, value)?;
        } else if !arena.xml_mode() && boolean_attribute(name) {
            arena.set_attr(&[*id], name, if truthy(value) { Some("") } else { None });
        } else {
            arena.set_attr(&[*id], name, Some(&js_string(value)));
        }
    }
    Ok(())
}

fn camel_case(value: &str) -> String {
    let mut result = String::new();
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if matches!(character, '.' | '_' | '-') {
            if chars.peek().is_none() {
                continue;
            }
            if chars
                .peek()
                .is_some_and(|character| character.is_ascii_alphanumeric() || *character == '_')
            {
                result.push(chars.next().unwrap().to_ascii_uppercase());
                continue;
            }
        }
        result.push(character);
    }
    result
}

fn css_case(value: &str) -> String {
    let mut result = String::new();
    for character in value.chars() {
        if character.is_ascii_uppercase() {
            result.push('-');
        }
        result.push(character.to_ascii_lowercase());
    }
    result
}

fn data_value(value: &str) -> Value {
    match value {
        "null" => return Value::Null,
        "true" => return json!(true),
        "false" => return json!(false),
        "NaN" | "Infinity" | "-Infinity" => return json!({"__nativeNumber": value}),
        _ => {}
    }
    if let Ok(number) = value.parse::<f64>() {
        let rendered = js_number(number);
        if rendered == value {
            if let Some(number) = Number::from_f64(number) {
                return Value::Number(number);
            }
        }
    }
    if value.starts_with('{') && value.ends_with('}')
        || value.starts_with('[') && value.ends_with(']')
    {
        if let Ok(value) = crate::codec::parse_json(value) {
            return value;
        }
    }
    json!(value)
}

fn read_data(arena: &mut DomArena, id: u32, name: Option<&str>) -> Value {
    if !element(arena, id) {
        return json!({"found":false});
    }
    let node = &mut arena.nodes[id as usize];
    let attributes = node.attribs.clone();
    let entry = node.extras.entry("data").or_insert_with(|| json!({}));
    if !entry.is_object() {
        *entry = json!({});
    }
    let data = entry.as_object_mut().unwrap();
    if let Some(name) = name {
        if !data.contains_key(name) {
            if let Some(value) = attributes
                .get(&format!("data-{}", css_case(name)))
                .and_then(Value::as_str)
            {
                data.insert(name.into(), data_value(value));
            }
        }
        match data.get(name) {
            Some(value) => json!({"found":true,"value":value}),
            None => json!({"found":false}),
        }
    } else {
        for (key, value) in attributes {
            if let Some(key) = key.strip_prefix("data-") {
                data.entry(camel_case(key))
                    .or_insert_with(|| data_value(value.as_str().unwrap_or("")));
            }
        }
        json!({"found":true,"value":data})
    }
}

fn descendants(arena: &DomArena, roots: &[u32], tag: Option<&str>) -> Vec<u32> {
    let mut output = Vec::new();
    for root in roots {
        let mut stack = arena
            .node(*root)
            .map(|node| node.children.iter().rev().copied().collect::<Vec<_>>())
            .unwrap_or_default();
        let mut seen = HashSet::new();
        while let Some(id) = stack.pop() {
            if !seen.insert(id) {
                continue;
            }
            let Some(node) = arena.node(id) else {
                continue;
            };
            if node.is_element() && tag.is_none_or(|tag| node.name.as_deref() == Some(tag)) {
                output.push(id);
            }
            stack.extend(node.children.iter().rev().copied());
        }
    }
    output
}

fn selected_options(arena: &DomArena, select: u32) -> Vec<u32> {
    let options = descendants(arena, &[select], Some("option"));
    let selected: Vec<_> = options
        .iter()
        .copied()
        .filter(|id| arena.attr(*id, "selected").is_some())
        .collect();
    if selected.is_empty() && arena.attr(select, "multiple").is_none() {
        options.into_iter().take(1).collect()
    } else {
        selected
    }
}

fn get_value(arena: &DomArena, ids: &[u32]) -> Value {
    let Some(id) = ids.first().copied() else {
        return Value::Null;
    };
    let Some(node) = arena.node(id).filter(|node| node.is_element()) else {
        return Value::Null;
    };
    match node.name.as_deref() {
        Some("textarea") => json!(arena.text(ids)),
        Some("input" | "option" | "button") => get_attr(arena, id, "value"),
        Some("select") => {
            let selected = selected_options(arena, id);
            if get_attr(arena, id, "multiple")
                .as_str()
                .is_some_and(|value| !value.is_empty())
            {
                json!(selected
                    .iter()
                    .map(|id| arena.text(&[*id]))
                    .collect::<Vec<_>>())
            } else {
                selected
                    .first()
                    .map(|id| get_attr(arena, *id, "value"))
                    .unwrap_or(Value::Null)
            }
        }
        _ => Value::Null,
    }
}

fn set_value(arena: &mut DomArena, ids: &[u32], value: &Value) -> bool {
    let Some(id) = ids.first().copied() else {
        return true;
    };
    let Some(node) = arena.node(id).filter(|node| node.is_element()) else {
        return true;
    };
    match node.name.as_deref() {
        Some("textarea") => arena.set_text(ids, &js_string(value)),
        Some("input" | "option" | "button") => {
            if value.get("__undefinedJavaScriptValue") == Some(&Value::Bool(true)) {
                return true;
            }
            let string = js_string(value);
            arena.set_attr(
                ids,
                "value",
                if value.is_null() { None } else { Some(&string) },
            );
        }
        Some("select") => {
            if arena.attr(id, "multiple").is_none() && value.is_array() {
                return true;
            }
            let values = value
                .as_array()
                .cloned()
                .unwrap_or_else(|| vec![value.clone()])
                .iter()
                .map(js_string)
                .collect::<HashSet<_>>();
            let options = descendants(arena, ids, Some("option"));
            for id in options {
                let selected = arena
                    .attr(id, "value")
                    .is_some_and(|value| values.contains(value));
                arena.set_attr(&[id], "selected", if selected { Some("") } else { None });
            }
        }
        _ => return false,
    }
    true
}

fn disabled(arena: &DomArena, id: u32) -> bool {
    // Cheerio's selector alias checks the control's own attribute. It does not
    // propagate a disabled fieldset to descendants as a browser does.
    arena.attr(id, "disabled").is_some()
}

fn serialize_array(arena: &DomArena, ids: &[u32]) -> Value {
    let mut controls = Vec::new();
    for id in ids {
        if arena
            .node(*id)
            .is_some_and(|node| node.name.as_deref() == Some("form"))
        {
            controls.extend(descendants(arena, &[*id], None));
        } else {
            controls.push(*id);
        }
    }
    let mut output = Vec::new();
    for id in controls {
        let Some(node) = arena.node(id) else {
            continue;
        };
        if !matches!(
            node.name.as_deref(),
            Some("input" | "select" | "textarea" | "keygen")
        ) || disabled(arena, id)
        {
            continue;
        }
        let Some(name) = arena.attr(id, "name").filter(|name| !name.is_empty()) else {
            continue;
        };
        let control_type = arena.attr(id, "type").unwrap_or("").to_ascii_lowercase();
        if matches!(
            control_type.as_str(),
            "submit" | "button" | "image" | "reset" | "file"
        ) || matches!(control_type.as_str(), "checkbox" | "radio")
            && arena.attr(id, "checked").is_none()
        {
            continue;
        }
        let value = get_value(arena, &[id]);
        let values = value
            .as_array()
            .cloned()
            .unwrap_or_else(|| vec![if value.is_null() { json!("") } else { value }]);
        for value in values {
            output.push(json!({"name":name,"value":js_string(&value).replace("\r\n", "\n").replace('\n', "\r\n")}));
        }
    }
    Value::Array(output)
}

fn encode_component(value: &str, encoded: bool) -> Result<String, ()> {
    let decoded;
    let value = if encoded && codec::has_encoding(value) {
        decoded = String::from_utf16(&codec::to_units(value)).map_err(|_| ())?;
        decoded.as_str()
    } else {
        value
    };
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            output.push(byte as char);
        } else if byte == b' ' {
            output.push('+');
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    Ok(output)
}

pub(crate) fn keeps_element_names(command: &str) -> bool {
    matches!(
        command,
        "attr"
            | "removeAttr"
            | "css"
            | "data"
            | "removeData"
            | "hasClass"
            | "addClass"
            | "removeClass"
            | "toggleClass"
            | "serializeArray"
            | "serialize"
    )
}

pub(crate) fn execute(
    arena: &mut DomArena,
    command: &str,
    args: &Value,
) -> napi::Result<Option<Value>> {
    let ids = value_ids(&args["ids"]);
    let first = ids.first().copied();
    let name = args.get("name").and_then(Value::as_str);
    let value = args.get("value");
    let result = match command {
        "attr" => {
            if let Some(value) = value {
                if let Some(name) = name {
                    let string = js_string(value);
                    arena.set_attr(
                        &ids,
                        name,
                        if value.is_null() { None } else { Some(&string) },
                    );
                }
                Value::Null
            } else {
                first
                    .map(|id| get_attr(arena, id, name.unwrap_or("")))
                    .unwrap_or(Value::Null)
            }
        }
        "removeAttr" => {
            for name in name.unwrap_or("").split_whitespace() {
                arena.set_attr(&ids, name, None);
            }
            Value::Null
        }
        "prop" => {
            if let Some(value) = value {
                if let Some(name) = name {
                    set_prop(arena, &ids, name, value)?;
                }
                Value::Null
            } else if let (Some(id), Some(name)) = (first, name) {
                if args.get("raw").and_then(Value::as_bool) == Some(true) {
                    if !element(arena, id) {
                        Value::Null
                    } else if node_property(arena, id, name) {
                        json!({"__nativeNodeProperty":name})
                    } else if !arena.xml_mode() && boolean_attribute(name) {
                        json!(arena.attr(id, name).is_some())
                    } else {
                        get_attr(arena, id, name)
                    }
                } else {
                    get_prop(arena, id, name)?
                }
            } else {
                Value::Null
            }
        }
        "css" => {
            if let (Some(name), Some(value)) = (name, value) {
                set_css(arena, &ids, name, value);
                Value::Null
            } else if let Some(id) = first.filter(|id| element(arena, *id)) {
                let properties = parse_css(arena.attr(id, "style").unwrap_or(""));
                if let Some(name) = name {
                    properties.get(name).cloned().unwrap_or(Value::Null)
                } else if let Some(names) = args.get("name").and_then(Value::as_array) {
                    Value::Object(
                        names
                            .iter()
                            .filter_map(|name| name.as_str())
                            .filter_map(|name| {
                                properties
                                    .get(name)
                                    .map(|value| (name.into(), value.clone()))
                            })
                            .collect(),
                    )
                } else {
                    Value::Object(properties)
                }
            } else {
                Value::Null
            }
        }
        "data" => {
            if let (Some(name), Some(value)) = (name, value) {
                for id in &ids {
                    if !element(arena, *id) {
                        continue;
                    }
                    let entry = arena.nodes[*id as usize]
                        .extras
                        .entry("data")
                        .or_insert_with(|| json!({}));
                    if !entry.is_object() {
                        *entry = json!({});
                    }
                    entry
                        .as_object_mut()
                        .unwrap()
                        .insert(name.into(), value.clone());
                }
                Value::Null
            } else {
                first
                    .map(|id| read_data(arena, id, name))
                    .unwrap_or_else(|| json!({"found":false}))
            }
        }
        "removeData" => {
            if let Some(name) = name {
                for id in &ids {
                    if let Some(data) = arena
                        .nodes
                        .get_mut(*id as usize)
                        .and_then(|node| node.extras.get_mut("data"))
                        .and_then(Value::as_object_mut)
                    {
                        data.shift_remove(name);
                    }
                }
            }
            Value::Null
        }
        "hasClass" => {
            let needle = name.unwrap_or("");
            json!(
                !needle.is_empty()
                    && ids.iter().any(|id| element(arena, *id)
                        && arena.attr(*id, "class").is_some_and(|classes| classes
                            .match_indices(needle)
                            .any(|(index, _)| {
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
                            })))
            )
        }
        "addClass" | "removeClass" | "toggleClass" => {
            let names: Vec<_> = name.unwrap_or("").split_whitespace().collect();
            for id in &ids {
                if !element(arena, *id) {
                    continue;
                }
                let old = arena.attr(*id, "class").unwrap_or("").to_owned();
                if command == "addClass" && !names.is_empty() {
                    let mut classes = format!(" {old} ");
                    for name in &names {
                        if !classes.contains(&format!(" {name} ")) {
                            classes.push_str(name);
                            classes.push(' ');
                        }
                    }
                    arena.set_attr(&[*id], "class", Some(classes.trim()));
                    continue;
                }
                let mut classes: Vec<String> = old.split_whitespace().map(str::to_owned).collect();
                let mut changed = false;
                if command == "removeClass"
                    && args.get("all").and_then(Value::as_bool) == Some(true)
                {
                    classes.clear();
                    changed = true;
                }
                for name in &names {
                    let present = classes.iter().any(|class| class == name);
                    let add = if command == "addClass" {
                        true
                    } else if command == "removeClass" {
                        false
                    } else {
                        args.get("state")
                            .and_then(Value::as_bool)
                            .unwrap_or(!present)
                    };
                    if add && !present {
                        classes.push((*name).into());
                        changed = true;
                    } else if !add && present {
                        classes.retain(|class| class != name);
                        changed = true;
                    }
                }
                if changed || command == "toggleClass" && !names.is_empty() {
                    arena.set_attr(&[*id], "class", Some(&classes.join(" ")));
                }
            }
            Value::Null
        }
        "val" => {
            if let Some(value) = value {
                if value.get("__undefinedJavaScriptValue") == Some(&Value::Bool(true))
                    && first
                        .and_then(|id| arena.node(id))
                        .is_some_and(|node| node.name.as_deref() == Some("textarea"))
                {
                    json!({"chain":false,"returnValue":get_value(arena,&ids)})
                } else {
                    json!(set_value(arena, &ids, value))
                }
            } else {
                get_value(arena, &ids)
            }
        }
        "serializeArray" => serialize_array(arena, &ids),
        "serialize" => {
            let fields = serialize_array(arena, &ids);
            let encoded = arena.options.get("__utf16Codec") == Some(&Value::Bool(true));
            let result = fields
                .as_array()
                .unwrap()
                .iter()
                .map(|field| {
                    Ok(format!(
                        "{}={}",
                        encode_component(field["name"].as_str().unwrap_or(""), encoded)?,
                        encode_component(field["value"].as_str().unwrap_or(""), encoded)?
                    ))
                })
                .collect::<Result<Vec<_>, ()>>();
            match result {
                Ok(fields) => json!(fields.join("&")),
                Err(()) => json!({"__nativeError":{"name":"URIError","message":"URI malformed"}}),
            }
        }
        _ => return Ok(None),
    };
    Ok(Some(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(source: &str) -> DomArena {
        crate::arena::parse_xml(
            source,
            json!({"xmlMode":false,"baseURI":"https://example.com/path/page"}),
        )
    }

    fn tag(arena: &DomArena, name: &str) -> u32 {
        arena
            .nodes
            .iter()
            .position(|node| node.name.as_deref() == Some(name))
            .unwrap() as u32
    }

    fn run(arena: &mut DomArena, command: &str, args: Value) -> Value {
        execute(arena, command, &args).unwrap().unwrap()
    }

    #[test]
    fn form_serialization_matches_cheerio_fieldset_and_control_semantics() {
        let mut arena = fixture("<form><fieldset disabled><legend><input name='allowed' value='yes'></legend><input name='child' value='no'></fieldset><input name='own' disabled value='gone'><input name='space' value='a b!'><input name='tick' type='checkbox' checked><textarea name='lines'>one\ntwo</textarea></form>");
        let form = tag(&arena, "form");
        assert_eq!(
            run(&mut arena, "serialize", json!({"ids":[form]})),
            json!("allowed=yes&child=no&space=a+b!&tick=on&lines=one%0D%0Atwo")
        );
    }

    #[test]
    fn form_percent_encoding_uses_original_unicode_and_rejects_lone_surrogates() {
        let mut arena = fixture("<form><input name='value'></form>");
        arena.options["__utf16Codec"] = Value::Bool(true);
        let form = tag(&arena, "form");
        let input = tag(&arena, "input");
        arena.set_attr(
            &[input],
            "value",
            Some(&codec::from_units(&[0xe000, 0xd83d, 0xde00])),
        );
        assert_eq!(
            run(&mut arena, "serialize", json!({"ids":[form]})),
            json!("value=%EE%80%80%F0%9F%98%80")
        );
        arena.set_attr(&[input], "value", Some(&codec::from_units(&[0xd800])));
        assert_eq!(
            run(&mut arena, "serialize", json!({"ids":[form]})),
            json!({"__nativeError":{"name":"URIError","message":"URI malformed"}})
        );
        assert_eq!(
            run(&mut arena, "serializeArray", json!({"ids":[form]}))[0]["value"],
            codec::from_units(&[0xd800])
        );
    }

    #[test]
    fn data_values_are_typed_cached_and_keep_canonical_number_rules() {
        let mut arena = fixture("<div data-null='null' data-ok='true' data-number='23' data-sci='1E10' data-json='[1,2]'></div>");
        let id = tag(&arena, "div");
        assert_eq!(
            run(&mut arena, "data", json!({"ids":[id],"name":"null"})),
            json!({"found":true,"value":null})
        );
        assert_eq!(
            run(&mut arena, "data", json!({"ids":[id],"name":"number"}))["value"],
            json!(23.0)
        );
        arena.set_attr(&[id], "data-number", Some("99"));
        let values = run(&mut arena, "data", json!({"ids":[id]}));
        assert_eq!(values["value"]["number"], json!(23.0));
        assert_eq!(values["value"]["sci"], json!("1E10"));
        assert_eq!(values["value"]["json"], json!([1, 2]));
    }

    #[test]
    fn styles_preserve_data_uri_semicolons_and_class_changes_preserve_whitespace() {
        let mut arena = fixture("<div class='one\ttwo' style='background: url(data:image/png;base64,AAA); margin: 0;'></div>");
        let id = tag(&arena, "div");
        assert_eq!(
            run(&mut arena, "css", json!({"ids":[id],"name":"background"})),
            json!("url(data:image/png;base64,AAA)")
        );
        run(&mut arena, "addClass", json!({"ids":[id],"name":"three"}));
        assert_eq!(arena.attr(id, "class"), Some("one\ttwo three"));
        run(
            &mut arena,
            "css",
            json!({"ids":[id],"name":"margin","value":""}),
        );
        assert_eq!(
            arena.attr(id, "style"),
            Some("background: url(data:image/png;base64,AAA);")
        );
    }

    #[test]
    fn properties_resolve_urls_and_boolean_attributes_stay_mode_specific() {
        let mut arena = fixture("<a href='../result'>Result</a><input checked>");
        let link = tag(&arena, "a");
        let input = tag(&arena, "input");
        assert_eq!(
            run(&mut arena, "prop", json!({"ids":[link],"name":"href"})),
            json!("https://example.com/result")
        );
        assert_eq!(
            run(&mut arena, "prop", json!({"ids":[input],"name":"checked"})),
            json!(true)
        );
        run(
            &mut arena,
            "prop",
            json!({"ids":[input],"name":"checked","value":false}),
        );
        assert_eq!(arena.attr(input, "checked"), None);
    }
}
