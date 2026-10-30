//! Source token locations for explicitly written HTML elements. Offsets and
//! columns count UTF-16 code units, matching JavaScript parser conventions.
use super::arena::DomNode;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};

#[derive(Clone, Copy)]
struct Position {
    line: usize,
    column: usize,
    offset: usize,
}
struct Element {
    name: String,
    start: usize,
    end: usize,
    start_end: usize,
    end_tag: Option<(usize, usize)>,
    attrs: Vec<(String, usize, usize)>,
}

fn range(positions: &[Position], start: usize, end: usize) -> Value {
    let a = positions[start];
    let b = positions[end];
    json!({"startLine":a.line,"startCol":a.column,"startOffset":a.offset,"endLine":b.line,"endCol":b.column,"endOffset":b.offset})
}

pub(crate) fn annotate(source: &str, nodes: &mut [DomNode], scripting: bool, codec: bool) {
    let mut positions = vec![
        Position {
            line: 1,
            column: 1,
            offset: 0
        };
        source.len() + 1
    ];
    let (mut line, mut column, mut offset) = (1, 1, 0);
    let mut cr = false;
    let mut escaped = false;
    for (index, ch) in source.char_indices() {
        let current = Position {
            line,
            column,
            offset,
        };
        for position in &mut positions[index..index + ch.len_utf8()] {
            *position = current;
        }
        let width = if codec && !escaped && ch == crate::codec::ESCAPE {
            escaped = true;
            0
        } else {
            escaped = false;
            ch.len_utf16()
        };
        offset += width;
        if ch == '\r' {
            line += 1;
            column = 1;
            cr = true;
        } else if ch == '\n' {
            if !cr {
                line += 1;
            }
            column = 1;
            cr = false;
        } else {
            column += width;
            cr = false;
        }
        positions[index + ch.len_utf8()] = Position {
            line,
            column,
            offset,
        };
    }
    let bytes = source.as_bytes();
    let mut characters: Vec<(String, usize, usize, bool)> = Vec::new();
    let mut comments: VecDeque<(usize, usize)> = VecDeque::new();
    let mut doctypes: VecDeque<(usize, usize)> = VecDeque::new();
    let mut elements: Vec<Element> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if let Some(open) = stack.last().copied() {
            let name = &elements[open].name;
            let raw = matches!(
                name.as_str(),
                "script"
                    | "style"
                    | "textarea"
                    | "title"
                    | "xmp"
                    | "iframe"
                    | "noembed"
                    | "noframes"
                    | "plaintext"
            ) || (scripting && name == "noscript");
            if raw {
                let close = format!("</{name}");
                if !source[index..]
                    .get(..close.len())
                    .is_some_and(|value| value.eq_ignore_ascii_case(&close))
                {
                    let mut found = None;
                    let mut search = index;
                    while let Some(relative) = source[search..].find('<') {
                        let candidate = search + relative;
                        if source[candidate..]
                            .get(..close.len())
                            .is_some_and(|value| value.eq_ignore_ascii_case(&close))
                        {
                            found = Some(candidate);
                            break;
                        }
                        search = candidate + 1;
                    }
                    if let Some(found) = found {
                        characters.push((
                            source[index..found].to_owned(),
                            index,
                            found,
                            matches!(name.as_str(), "textarea" | "title"),
                        ));
                        index = found;
                    } else {
                        characters.push((
                            source[index..].to_owned(),
                            index,
                            bytes.len(),
                            matches!(name.as_str(), "textarea" | "title"),
                        ));
                        break;
                    }
                }
            }
        }
        let Some(relative) = source[index..].find('<') else {
            characters.push((source[index..].to_owned(), index, bytes.len(), true));
            break;
        };
        if relative > 0 {
            characters.push((
                source[index..index + relative].to_owned(),
                index,
                index + relative,
                true,
            ));
        }
        index += relative;
        let start = index;
        if source[index..].starts_with("<!--") {
            index = source[index + 4..]
                .find("-->")
                .map_or(bytes.len(), |end| index + end + 7);
            comments.push_back((start, index));
            continue;
        }
        let mut cursor = index + 1;
        let mut quote = None;
        while cursor < bytes.len() {
            let ch = bytes[cursor];
            if let Some(q) = quote {
                if ch == q {
                    quote = None;
                }
            } else if ch == b'\'' || ch == b'"' {
                quote = Some(ch);
            } else if ch == b'>' {
                break;
            }
            cursor += 1;
        }
        if cursor == bytes.len() {
            break;
        }
        index = cursor + 1;
        let token = &source[start + 1..cursor];
        if token.to_ascii_lowercase().starts_with("!doctype") {
            doctypes.push_back((start, index));
            continue;
        }
        if token.starts_with('!') || token.starts_with('?') {
            comments.push_back((start, index));
            continue;
        }
        if !token.starts_with('/')
            && !token
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphabetic)
        {
            characters.push((source[start..index].to_owned(), start, index, true));
            continue;
        }
        if let Some(close) = token.strip_prefix('/') {
            let name = close
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            if let Some(position) = stack.iter().rposition(|id| elements[*id].name == name) {
                for id in stack.drain(position..) {
                    elements[id].end = if elements[id].name == name {
                        index
                    } else {
                        start
                    };
                    if elements[id].name == name {
                        elements[id].end_tag = Some((start, index));
                    }
                }
            }
            continue;
        }
        let name_end = token
            .find(|ch: char| ch.is_whitespace() || ch == '/')
            .unwrap_or(token.len());
        if name_end == 0 {
            continue;
        }
        let name = token[..name_end].to_ascii_lowercase();
        if matches!(name.as_str(), "p" | "li" | "option" | "dt" | "dd") {
            if let Some(position) = stack.iter().rposition(|id| elements[*id].name == name) {
                for id in stack.drain(position..) {
                    elements[id].end = start;
                }
            }
        }
        let mut attrs = Vec::new();
        let mut at = start + 1 + name_end;
        while at < cursor {
            while at < cursor && bytes[at].is_ascii_whitespace() {
                at += 1;
            }
            if at >= cursor || bytes[at] == b'/' {
                break;
            }
            let attr_start = at;
            while at < cursor
                && !bytes[at].is_ascii_whitespace()
                && !matches!(bytes[at], b'=' | b'/' | b'>')
            {
                at += 1;
            }
            if attr_start == at {
                at += 1;
                continue;
            }
            let attr_name = source[attr_start..at].to_ascii_lowercase();
            let mut attr_end = at;
            while at < cursor && bytes[at].is_ascii_whitespace() {
                at += 1;
            }
            if bytes.get(at) == Some(&b'=') {
                at += 1;
                while at < cursor && bytes[at].is_ascii_whitespace() {
                    at += 1;
                }
                if matches!(bytes.get(at), Some(b'\'' | b'"')) {
                    let q = bytes[at];
                    at += 1;
                    while at < cursor && bytes[at] != q {
                        at += 1;
                    }
                    at += (at < cursor) as usize;
                } else {
                    while at < cursor && !bytes[at].is_ascii_whitespace() {
                        at += 1;
                    }
                }
                attr_end = at;
            }
            attrs.push((attr_name, attr_start, attr_end));
        }
        let void = super::void_name(&name) || token.trim_end().ends_with('/');
        let id = elements.len();
        elements.push(Element {
            name,
            start,
            end: if void { index } else { source.len() },
            start_end: index,
            end_tag: None,
            attrs,
        });
        if !void {
            stack.push(id);
        }
    }
    let mut by_name: HashMap<String, VecDeque<Value>> = HashMap::new();
    for element in elements {
        let mut value = range(&positions, element.start, element.end);
        value["startTag"] = range(&positions, element.start, element.start_end);
        if let Some((start, end)) = element.end_tag {
            value["endTag"] = range(&positions, start, end);
        }
        if !element.attrs.is_empty() {
            let mut attrs = Map::new();
            for (name, start, end) in element.attrs {
                attrs
                    .entry(name)
                    .or_insert_with(|| range(&positions, start, end));
            }
            value["startTag"]["attrs"] = Value::Object(attrs.clone());
            value["attrs"] = Value::Object(attrs);
        }
        by_name.entry(element.name).or_default().push_back(value);
    }
    // Match character tokens to the completed DOM. Foster parenting can merge
    // text across table markup, so consume matching fragments independently of
    // their eventual tree order.
    let mut text: Vec<_> = characters
        .into_iter()
        .map(|(data, start, end, decode)| {
            let data = data
                .replace("\r\n", "\n")
                .replace('\r', "\n")
                .replace('\0', "\u{fffd}");
            let data = if decode {
                crate::arena::decode_entities_mode(&data, false, false, codec)
            } else {
                data
            };
            (data, start, end, false)
        })
        .collect();
    for node in nodes {
        if node.kind == "root" && node.parent.is_some() {
            node.extras.insert("sourceCodeLocation".into(), Value::Null);
        }
        if node.is_element() {
            node.extras.insert("sourceCodeLocation".into(), Value::Null);
        }
        if node.kind == "comment" {
            if let Some((start, end)) = comments.pop_front() {
                node.extras
                    .insert("sourceCodeLocation".into(), range(&positions, start, end));
            }
        }
        if node.kind == "directive" {
            if let Some((start, end)) = doctypes.pop_front() {
                node.extras
                    .insert("sourceCodeLocation".into(), range(&positions, start, end));
            }
        }
        if node.kind == "text" {
            let mut remaining = node.data.as_deref().unwrap_or("");
            let mut first = None;
            let mut last = 0;
            for (data, start, end, used) in &mut text {
                if *used || data.is_empty() {
                    continue;
                }
                let mut part = data.as_str();
                let mut token_start = *start;
                if first.is_none() && part.starts_with('\n') && remaining == &part[1..] {
                    part = &part[1..];
                    token_start += if source[*start..].starts_with("\r\n") {
                        2
                    } else {
                        1
                    };
                }
                if remaining.starts_with(part) {
                    if first.is_none() {
                        first = Some(token_start);
                    }
                    last = *end;
                    remaining = &remaining[part.len()..];
                    *used = true;
                    if remaining.is_empty() {
                        break;
                    }
                }
            }
            if remaining.is_empty() {
                if let Some(start) = first {
                    node.extras
                        .insert("sourceCodeLocation".into(), range(&positions, start, last));
                }
            }
        }
        if let Some(name) = &node.name {
            if let Some(location) = by_name
                .get_mut(&name.to_ascii_lowercase())
                .and_then(VecDeque::pop_front)
            {
                node.extras.insert("sourceCodeLocation".into(), location);
            }
        }
    }
}
