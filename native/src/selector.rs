//! Cheerio-compatible CSS and jQuery selection over the native mutable DOM.

use crate::id_hash::{IdMap, IdSet};
use napi::{Error, Result, Status};

pub(crate) trait SelectDom {
    fn kind(&self, id: u32) -> &str;
    fn name(&self, id: u32) -> Option<&str>;
    fn attr(&self, id: u32, name: &str) -> Option<&str>;
    fn parent(&self, id: u32) -> Option<u32>;
    fn children(&self, id: u32) -> &[u32];
    fn text(&self, id: u32) -> String;
    fn xml_mode(&self) -> bool;
    fn lower_case_tags(&self) -> bool {
        !self.xml_mode()
    }
    fn lower_case_attribute_names(&self) -> bool {
        !self.xml_mode()
    }
    fn custom_pseudo(&self, _id: u32, _name: &str, _argument: Option<&str>) -> Option<bool> {
        None
    }
    fn pseudo_alias(&self, _name: &str) -> Option<&str> {
        None
    }
    /// Every element whose ASCII-lowercased name is `lowercase_name`, in
    /// document order, when the tree keeps such an index.
    fn elements_named(&self, _lowercase_name: &str) -> Option<&[u32]> {
        None
    }
    /// Whether ascending ids are document order for every node.
    fn is_id_order_document_order(&self) -> bool {
        false
    }
}

/// Attributes whose values css-select compares case-insensitively in HTML
/// documents when a selector has no `i` or `s` flag.
pub(crate) const CASE_INSENSITIVE_ATTRIBUTES: &[&str] = &[
    "accept",
    "accept-charset",
    "align",
    "alink",
    "axis",
    "bgcolor",
    "charset",
    "checked",
    "clear",
    "codetype",
    "color",
    "compact",
    "declare",
    "defer",
    "dir",
    "direction",
    "disabled",
    "enctype",
    "face",
    "frame",
    "hreflang",
    "http-equiv",
    "lang",
    "language",
    "link",
    "media",
    "method",
    "multiple",
    "nohref",
    "noresize",
    "noshade",
    "nowrap",
    "readonly",
    "rel",
    "rev",
    "rules",
    "scope",
    "scrolling",
    "selected",
    "shape",
    "target",
    "text",
    "type",
    "valign",
    "valuetype",
    "vlink",
];

const KNOWN: &[&str] = &[
    "not",
    "is",
    "where",
    "matches",
    "has",
    "contains",
    "icontains",
    "first",
    "last",
    "eq",
    "nth",
    "lt",
    "gt",
    "even",
    "odd",
    "root",
    "scope",
    "empty",
    "parent",
    "first-child",
    "last-child",
    "only-child",
    "nth-child",
    "nth-last-child",
    "first-of-type",
    "last-of-type",
    "only-of-type",
    "nth-of-type",
    "nth-last-of-type",
    "header",
    "input",
    "button",
    "text",
    "checkbox",
    "file",
    "password",
    "radio",
    "reset",
    "image",
    "submit",
    "selected",
    "checked",
    "disabled",
    "enabled",
    "link",
    "any-link",
    "visited",
    "active",
    "hover",
    "required",
    "optional",
];

#[derive(Clone, Copy)]
enum Combinator {
    Descendant,
    Child,
    Next,
    Following,
}

#[derive(Clone)]
enum Test {
    Tag(String),
    Id(String),
    Class(String),
    Attribute {
        name: String,
        op: String,
        value: String,
        flag: Option<char>,
    },
    Pseudo(String, String),
}

#[derive(Clone)]
struct Complex {
    parts: Vec<Vec<Test>>,
    combinators: Vec<Combinator>,
    leading: Option<Combinator>,
}

fn validate<D: SelectDom>(dom: &D, complex: &Complex) -> Result<()> {
    for part in &complex.parts {
        for test in part {
            if let Test::Pseudo(name, argument) = test {
                if !KNOWN.contains(&name.as_str())
                    && dom.custom_pseudo(0, name, Some(argument)).is_none()
                    && dom.pseudo_alias(name).is_none()
                {
                    return Err(invalid(format!("Unknown pseudo-class :{name}")));
                }
                if matches!(name.as_str(), "not" | "is" | "where" | "matches" | "has") {
                    for nested in parse(argument)?.iter() {
                        validate(dom, nested)?;
                    }
                }
            }
        }
    }
    Ok(())
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn tag<D: SelectDom>(dom: &D, id: u32) -> bool {
    matches!(dom.kind(id), "tag" | "script" | "style")
}

fn escape_end(chars: &[char], start: usize) -> usize {
    let mut i = start + 1;
    if i >= chars.len() {
        return i;
    }
    if chars[i].is_ascii_hexdigit() {
        let end = (i + 6).min(chars.len());
        while i < end && chars[i].is_ascii_hexdigit() {
            i += 1;
        }
        if i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        i
    } else {
        i + 1
    }
}

fn unescape(value: &str) -> String {
    if !value.contains('\\') {
        return value.to_owned();
    }
    let chars: Vec<char> = value.chars().collect();
    let mut result = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '\\' {
            result.push(chars[i]);
            i += 1;
            continue;
        }
        let end = escape_end(&chars, i);
        let hexadecimal: String = chars[i + 1..end]
            .iter()
            .take_while(|c| c.is_ascii_hexdigit())
            .collect();
        if hexadecimal.is_empty() {
            if i + 1 < chars.len() {
                result.push(chars[i + 1]);
            }
        } else {
            let code = u32::from_str_radix(&hexadecimal, 16).unwrap_or(0);
            // css-what decodes escapes with JavaScript String.fromCharCode,
            // including lone surrogate code units and paired escapes.
            let units = if code <= 0xffff {
                vec![code as u16]
            } else {
                let high = code - 0x10000;
                vec![
                    ((high >> 10) | 0xd800) as u16,
                    ((high & 0x3ff) | 0xdc00) as u16,
                ]
            };
            result.push_str(&crate::codec::from_units(&units));
        }
        i = end;
    }
    if crate::codec::has_encoding(&result) {
        crate::codec::from_units(&crate::codec::to_units(&result))
    } else {
        result
    }
}

fn equal_strings(left: &str, right: &str) -> bool {
    left == right
        || !(left.is_ascii() && right.is_ascii())
            && (crate::codec::has_encoding(left) || crate::codec::has_encoding(right))
            && crate::codec::to_units(left) == crate::codec::to_units(right)
}

fn starts_with(text: &str, value: &str) -> bool {
    if crate::codec::has_encoding(text) || crate::codec::has_encoding(value) {
        crate::codec::to_units(text).starts_with(&crate::codec::to_units(value))
    } else {
        text.starts_with(value)
    }
}

fn ends_with(text: &str, value: &str) -> bool {
    if crate::codec::has_encoding(text) || crate::codec::has_encoding(value) {
        crate::codec::to_units(text).ends_with(&crate::codec::to_units(value))
    } else {
        text.ends_with(value)
    }
}

fn contains(text: &str, value: &str) -> bool {
    if crate::codec::has_encoding(text) || crate::codec::has_encoding(value) {
        let text = crate::codec::to_units(text);
        let value = crate::codec::to_units(value);
        value.is_empty() || text.windows(value.len()).any(|window| window == value)
    } else {
        text.contains(value)
    }
}

fn identifier(chars: &[char], i: &mut usize) -> String {
    let start = *i;
    while *i < chars.len() {
        let c = chars[*i];
        if c == '\\' {
            *i = escape_end(chars, *i);
        } else if c.is_alphanumeric() || c == '-' || c == '_' || !c.is_ascii() {
            *i += 1;
        } else {
            break;
        }
    }
    unescape(&chars[start..*i].iter().collect::<String>())
}

fn split_groups(source: &str) -> Result<Vec<String>> {
    let chars: Vec<char> = source.chars().collect();
    let mut groups = Vec::new();
    let (mut i, mut start, mut brackets, mut parentheses) = (0, 0, 0i32, 0i32);
    let mut quote = None;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' {
            i = escape_end(&chars, i);
            continue;
        }
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        match c {
            '\'' | '"' => quote = Some(c),
            '[' => brackets += 1,
            ']' => brackets -= 1,
            '(' if brackets == 0 => parentheses += 1,
            ')' if brackets == 0 => parentheses -= 1,
            ',' if brackets == 0 && parentheses == 0 => {
                groups.push(
                    chars[start..i]
                        .iter()
                        .collect::<String>()
                        .trim()
                        .to_string(),
                );
                start = i + 1;
            }
            _ => {}
        }
        if brackets < 0 || parentheses < 0 {
            return Err(invalid("Unmatched selector delimiter"));
        }
        i += 1;
    }
    if brackets != 0 || parentheses != 0 || quote.is_some() {
        return Err(invalid("Unmatched selector delimiter"));
    }
    groups.push(chars[start..].iter().collect::<String>().trim().to_string());
    if groups.iter().any(String::is_empty) {
        return Err(invalid("Empty sub-selector"));
    }
    Ok(groups)
}

fn parse_attribute(source: &str) -> Result<Test> {
    let chars: Vec<char> = source.trim().chars().collect();
    let mut i = 0;
    let mut name = identifier(&chars, &mut i);
    if i < chars.len() && chars[i] == ':' {
        i += 1;
        name.push(':');
        name.push_str(&identifier(&chars, &mut i));
    }
    if name.is_empty() {
        return Err(invalid("Malformed attribute selector"));
    }
    while i < chars.len() && chars[i].is_whitespace() {
        i += 1;
    }
    if i == chars.len() {
        return Ok(Test::Attribute {
            name,
            op: String::new(),
            value: String::new(),
            flag: None,
        });
    }
    let mut op = String::new();
    if "!~|^$*".contains(chars[i]) {
        op.push(chars[i]);
        i += 1;
    }
    if chars.get(i) != Some(&'=') {
        return Err(invalid("Attribute selector is missing an operator"));
    }
    op.push('=');
    i += 1;
    while i < chars.len() && chars[i].is_whitespace() {
        i += 1;
    }
    let value;
    if matches!(chars.get(i), Some('\'' | '"')) {
        let quote = chars[i];
        i += 1;
        let start = i;
        while i < chars.len() && chars[i] != quote {
            i = if chars[i] == '\\' {
                escape_end(&chars, i)
            } else {
                i + 1
            };
        }
        if i >= chars.len() {
            return Err(invalid("Unmatched attribute quote"));
        }
        value = unescape(&chars[start..i].iter().collect::<String>());
        i += 1;
    } else {
        let start = i;
        while i < chars.len() && !chars[i].is_whitespace() {
            i = if chars[i] == '\\' {
                escape_end(&chars, i)
            } else {
                i + 1
            };
        }
        value = unescape(&chars[start..i].iter().collect::<String>());
    }
    while i < chars.len() && chars[i].is_whitespace() {
        i += 1;
    }
    let flag = chars.get(i).copied().map(|c| c.to_ascii_lowercase());
    if flag.is_some_and(|c| c != 'i' && c != 's') || i + usize::from(flag.is_some()) < chars.len() {
        return Err(invalid("Invalid attribute selector flag"));
    }
    Ok(Test::Attribute {
        name,
        op,
        value,
        flag,
    })
}

fn parse_compound(source: &str) -> Result<Vec<Test>> {
    let chars: Vec<char> = source.chars().collect();
    let mut tests = Vec::new();
    let mut i = 0;
    if chars.first() == Some(&'*') {
        i += 1;
    } else if chars
        .first()
        .is_some_and(|c| *c != '#' && *c != '.' && *c != '[' && *c != ':')
    {
        let name = identifier(&chars, &mut i);
        if name.is_empty() {
            return Err(invalid(format!("Unexpected selector {source:?}")));
        }
        tests.push(Test::Tag(name));
    }
    while i < chars.len() {
        let marker = chars[i];
        i += 1;
        match marker {
            '#' | '.' => {
                let name = identifier(&chars, &mut i);
                if name.is_empty() {
                    return Err(invalid("Expected selector identifier"));
                }
                tests.push(if marker == '#' {
                    Test::Id(name)
                } else {
                    Test::Class(name)
                });
            }
            '[' => {
                let start = i;
                let mut quote = None;
                while i < chars.len() {
                    let c = chars[i];
                    if c == '\\' {
                        i = escape_end(&chars, i);
                        continue;
                    }
                    if let Some(q) = quote {
                        if c == q {
                            quote = None;
                        }
                    } else if c == '\'' || c == '"' {
                        quote = Some(c);
                    } else if c == ']' {
                        break;
                    }
                    i += 1;
                }
                if i == chars.len() {
                    return Err(invalid("Unmatched attribute selector"));
                }
                tests.push(parse_attribute(
                    &chars[start..i].iter().collect::<String>(),
                )?);
                i += 1;
            }
            ':' => {
                let name = identifier(&chars, &mut i).to_ascii_lowercase();
                if name.is_empty() {
                    return Err(invalid("Expected pseudo-class name"));
                }
                let mut argument = String::new();
                if chars.get(i) == Some(&'(') {
                    i += 1;
                    let start = i;
                    let mut depth = 1;
                    let mut quote = None;
                    while i < chars.len() {
                        let c = chars[i];
                        if c == '\\' {
                            i = escape_end(&chars, i);
                            continue;
                        }
                        if let Some(q) = quote {
                            if c == q {
                                quote = None;
                            }
                        } else if c == '\'' || c == '"' {
                            quote = Some(c);
                        } else if c == '(' {
                            depth += 1;
                        } else if c == ')' {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        i += 1;
                    }
                    if depth != 0 {
                        return Err(invalid("Unmatched pseudo-class argument"));
                    }
                    argument = chars[start..i]
                        .iter()
                        .collect::<String>()
                        .trim()
                        .to_string();
                    i += 1;
                }
                tests.push(Test::Pseudo(name, argument));
            }
            _ => return Err(invalid(format!("Unexpected selector character {marker:?}"))),
        }
    }
    Ok(tests)
}

thread_local! {
    /// Parsed selectors by source; queries reuse a handful of selectors many times.
    static PARSED: std::cell::RefCell<std::collections::HashMap<String, std::rc::Rc<Vec<Complex>>>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}
const PARSED_LIMIT: usize = 512;

fn parse(source: &str) -> Result<std::rc::Rc<Vec<Complex>>> {
    if let Some(parsed) = PARSED.with(|cache| cache.borrow().get(source).cloned()) {
        return Ok(parsed);
    }
    let parsed = std::rc::Rc::new(parse_uncached(source)?);
    PARSED.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() >= PARSED_LIMIT {
            cache.clear();
        }
        cache.insert(source.to_owned(), parsed.clone());
    });
    Ok(parsed)
}

fn parse_uncached(source: &str) -> Result<Vec<Complex>> {
    split_groups(source)?
        .iter()
        .map(|group| {
            let chars: Vec<char> = group.chars().collect();
            let mut parts = Vec::new();
            let mut combinators = Vec::new();
            let mut leading = None;
            let (mut i, mut start, mut brackets, mut parentheses) = (0, 0, 0i32, 0i32);
            let mut quote = None;
            while i < chars.len() {
                let c = chars[i];
                if c == '\\' {
                    i = escape_end(&chars, i);
                    continue;
                }
                if let Some(q) = quote {
                    if c == q {
                        quote = None;
                    }
                    i += 1;
                    continue;
                }
                match c {
                    '\'' | '"' => quote = Some(c),
                    '[' => brackets += 1,
                    ']' => brackets -= 1,
                    '(' => parentheses += 1,
                    ')' => parentheses -= 1,
                    _ => {}
                }
                if brackets == 0 && parentheses == 0 && (c.is_whitespace() || ">+~".contains(c)) {
                    if start < i {
                        parts.push(parse_compound(&chars[start..i].iter().collect::<String>())?);
                    }
                    let mut combinator = Combinator::Descendant;
                    while i < chars.len() && chars[i].is_whitespace() {
                        i += 1;
                    }
                    if i < chars.len() && ">+~".contains(chars[i]) {
                        combinator = match chars[i] {
                            '>' => Combinator::Child,
                            '+' => Combinator::Next,
                            _ => Combinator::Following,
                        };
                        i += 1;
                        while i < chars.len() && chars[i].is_whitespace() {
                            i += 1;
                        }
                        if i == chars.len() {
                            return Err(invalid("Selector cannot end with a combinator"));
                        }
                    }
                    if parts.is_empty() {
                        leading = Some(combinator);
                    } else if i < chars.len() {
                        combinators.push(combinator);
                    }
                    start = i;
                    continue;
                }
                i += 1;
            }
            if start < i {
                parts.push(parse_compound(&chars[start..i].iter().collect::<String>())?);
            }
            if parts.is_empty() || combinators.len() + 1 != parts.len() {
                return Err(invalid("Invalid combinator in selector"));
            }
            Ok(Complex {
                parts,
                combinators,
                leading,
            })
        })
        .collect()
}

fn unique(ids: impl IntoIterator<Item = u32>) -> Vec<u32> {
    let mut seen = IdSet::default();
    ids.into_iter().filter(|id| seen.insert(*id)).collect()
}

fn descendants<D: SelectDom>(dom: &D, roots: &[u32]) -> Vec<u32> {
    let mut output = Vec::new();
    for root in roots {
        let scope_barrier = tag(dom, *root);
        let mut stack: Vec<u32> = dom.children(*root).iter().rev().copied().collect();
        while let Some(id) = stack.pop() {
            if scope_barrier && dom.kind(id) == "root" {
                continue;
            }
            if tag(dom, id) {
                output.push(id);
            }
            stack.extend(dom.children(id).iter().rev().copied());
        }
    }
    // One root's descendants are distinct; only overlapping roots repeat.
    if roots.len() > 1 {
        unique(output)
    } else {
        output
    }
}

/// Visits the elements below `root` in document order, as `descendants` lists
/// them for one root, until `visit` returns false.
fn for_each_descendant<D: SelectDom>(dom: &D, root: u32, mut visit: impl FnMut(u32) -> bool) {
    let scope_barrier = tag(dom, root);
    let mut stack: Vec<u32> = dom.children(root).iter().rev().copied().collect();
    while let Some(id) = stack.pop() {
        let kind = dom.kind(id);
        if scope_barrier && kind == "root" {
            continue;
        }
        if matches!(kind, "tag" | "script" | "style") && !visit(id) {
            return;
        }
        stack.extend(dom.children(id).iter().rev().copied());
    }
}

fn siblings<D: SelectDom>(dom: &D, id: u32) -> Vec<u32> {
    dom.parent(id).map_or_else(Vec::new, |parent| {
        dom.children(parent)
            .iter()
            .copied()
            .filter(|id| tag(dom, *id))
            .collect()
    })
}

fn expand<D: SelectDom>(dom: &D, ids: &[u32], combinator: Combinator) -> Vec<u32> {
    match combinator {
        Combinator::Descendant => descendants(dom, ids),
        Combinator::Child => unique(
            ids.iter()
                .flat_map(|id| dom.children(*id))
                .copied()
                .filter(|id| tag(dom, *id)),
        ),
        Combinator::Next | Combinator::Following => unique(ids.iter().flat_map(|id| {
            let siblings = siblings(dom, *id);
            let offset = siblings
                .iter()
                .position(|other| other == id)
                .map_or(siblings.len(), |i| i + 1);
            let limit = if matches!(combinator, Combinator::Next) {
                1
            } else {
                siblings.len()
            };
            siblings
                .into_iter()
                .skip(offset)
                .take(limit)
                .collect::<Vec<_>>()
        })),
    }
}

fn position(name: &str) -> bool {
    matches!(
        name,
        "first" | "last" | "eq" | "nth" | "lt" | "gt" | "even" | "odd"
    )
}

fn has_position(source: &str) -> Result<bool> {
    for complex in parse(source)?.iter() {
        for part in &complex.parts {
            for test in part {
                if let Test::Pseudo(name, argument) = test {
                    if position(name)
                        || (matches!(name.as_str(), "not" | "is" | "where" | "matches")
                            && has_position(argument)?)
                    {
                        return Ok(true);
                    }
                }
            }
        }
    }
    Ok(false)
}

fn nth(argument: &str, index: usize, total: usize, reverse: bool) -> bool {
    let expression = argument
        .to_ascii_lowercase()
        .replace(char::is_whitespace, "");
    let n = if reverse { total - index } else { index + 1 } as i64;
    if expression == "odd" {
        return n % 2 == 1;
    }
    if expression == "even" {
        return n % 2 == 0;
    }
    if let Some(at) = expression.find('n') {
        let coefficient = match &expression[..at] {
            "" | "+" => Some(1),
            "-" => Some(-1),
            other => other.parse::<i64>().ok(),
        };
        let offset = if at + 1 == expression.len() {
            Some(0)
        } else {
            expression[at + 1..].parse::<i64>().ok()
        };
        match (coefficient, offset) {
            (Some(0), Some(b)) => n == b,
            (Some(a), Some(b)) => (n - b) * a >= 0 && (n - b) % a == 0,
            _ => false,
        }
    } else {
        expression.parse::<i64>().ok() == Some(n)
    }
}

fn disabled<D: SelectDom>(dom: &D, id: u32) -> bool {
    let name = dom.name(id).unwrap_or("");
    if name == "option"
        && dom.parent(id).is_some_and(|parent| {
            dom.name(parent) == Some("optgroup") && dom.attr(parent, "disabled").is_some()
        })
    {
        return true;
    }
    if dom.attr(id, "disabled").is_none() {
        return false;
    }
    if matches!(
        name,
        "button" | "input" | "select" | "textarea" | "optgroup" | "option"
    ) {
        return true;
    }
    if name != "fieldset" {
        return false;
    }
    // Follow Cheerio/css-select's alias, including its fieldset/legend rule.
    let mut parent = dom.parent(id);
    while let Some(ancestor) = parent {
        if dom.name(ancestor) == Some("legend") {
            if let Some(fieldset) = dom.parent(ancestor) {
                if dom.name(fieldset) == Some("fieldset")
                    && dom.attr(fieldset, "disabled").is_some()
                    && dom
                        .children(fieldset)
                        .iter()
                        .copied()
                        .find(|id| dom.name(*id) == Some("legend"))
                        == Some(ancestor)
                {
                    return false;
                }
            }
        }
        parent = dom.parent(ancestor);
    }
    true
}

fn selected<D: SelectDom>(dom: &D, id: u32) -> bool {
    if dom.name(id) != Some("option") {
        return false;
    }
    if dom.attr(id, "selected").is_some() {
        return true;
    }
    let Some(parent) = dom.parent(id) else {
        return false;
    };
    if dom.name(parent) != Some("select") || dom.attr(parent, "multiple").is_some() {
        return false;
    }
    let options: Vec<_> = dom
        .children(parent)
        .iter()
        .copied()
        .filter(|id| dom.name(*id) == Some("option"))
        .collect();
    options.first() == Some(&id) && !options.iter().any(|id| dom.attr(*id, "selected").is_some())
}

fn attr_matches<D: SelectDom>(
    dom: &D,
    id: u32,
    name: &str,
    op: &str,
    value: &str,
    flag: Option<char>,
) -> bool {
    let name = if !dom.lower_case_attribute_names() {
        name.to_string()
    } else {
        name.to_ascii_lowercase()
    };
    let attribute = dom.attr(id, &name);
    if op.is_empty() {
        return attribute.is_some();
    }
    let Some(attribute) = attribute else {
        return op == "!=" && !value.is_empty();
    };
    let insensitive = flag == Some('i')
        || (flag != Some('s')
            && !dom.xml_mode()
            && CASE_INSENSITIVE_ATTRIBUTES.contains(&name.as_str()));
    let (attribute, value) = if insensitive {
        (attribute.to_lowercase(), value.to_lowercase())
    } else {
        (attribute.to_string(), value.to_string())
    };
    match op {
        "=" => equal_strings(&attribute, &value),
        "!=" => !equal_strings(&attribute, &value),
        "~=" => {
            !value.is_empty()
                && attribute
                    .split_whitespace()
                    .any(|part| equal_strings(part, &value))
        }
        "|=" => equal_strings(&attribute, &value) || starts_with(&attribute, &(value + "-")),
        "^=" => !value.is_empty() && starts_with(&attribute, &value),
        "$=" => !value.is_empty() && ends_with(&attribute, &value),
        "*=" => !value.is_empty() && contains(&attribute, &value),
        _ => false,
    }
}

fn matches_backwards<D: SelectDom>(
    dom: &D,
    id: u32,
    complex: &Complex,
    index: usize,
    scope: &[u32],
    memo: &mut BackwardMemo,
) -> Result<bool> {
    matches_backwards_within(dom, id, complex, index, scope, None, memo)
}

/// Results of matching an element against the compounds up to an index, for
/// one complex selector, scope and allowed set. Without it, chains of
/// descendant combinators retry the same ancestors for every candidate,
/// which grows exponentially with nesting depth.
#[derive(Default)]
struct BackwardMemo(IdMap<u64, bool>);

/// Matches right to left. With `allowed`, every element matched for an
/// earlier compound must be in that set.
fn matches_backwards_within<D: SelectDom>(
    dom: &D,
    id: u32,
    complex: &Complex,
    index: usize,
    scope: &[u32],
    allowed: Option<&IdSet<u32>>,
    memo: &mut BackwardMemo,
) -> Result<bool> {
    // One combinator cannot repeat work; the memo would only cost lookups.
    let key = (complex.parts.len() > 2).then(|| (index as u64) << 32 | u64::from(id));
    if let Some(known) = key.and_then(|key| memo.0.get(&key)) {
        return Ok(*known);
    }
    let matched = matches_backwards_uncached(dom, id, complex, index, scope, allowed, memo)?;
    if let Some(key) = key {
        memo.0.insert(key, matched);
    }
    Ok(matched)
}

fn matches_backwards_uncached<D: SelectDom>(
    dom: &D,
    id: u32,
    complex: &Complex,
    index: usize,
    scope: &[u32],
    allowed: Option<&IdSet<u32>>,
    memo: &mut BackwardMemo,
) -> Result<bool> {
    if !matches_compound(dom, id, &complex.parts[index], scope)? {
        return Ok(false);
    }
    if index == 0 {
        return Ok(true);
    }
    let relation = complex.combinators[index - 1];
    let candidates = match relation {
        Combinator::Child => dom
            .parent(id)
            .into_iter()
            .filter(|id| tag(dom, *id))
            .collect(),
        Combinator::Descendant => {
            let mut parents = Vec::new();
            let mut parent = dom.parent(id);
            while let Some(id) = parent {
                if !tag(dom, id) {
                    break;
                }
                parents.push(id);
                parent = dom.parent(id);
            }
            parents
        }
        Combinator::Next | Combinator::Following => {
            let mut others = siblings(dom, id);
            let offset = others.iter().position(|other| *other == id).unwrap_or(0);
            others.truncate(offset);
            if matches!(relation, Combinator::Next) {
                others.into_iter().rev().take(1).collect()
            } else {
                others
            }
        }
    };
    for candidate in candidates {
        if allowed.is_some_and(|allowed| !allowed.contains(&candidate)) {
            continue;
        }
        if matches_backwards_within(dom, candidate, complex, index - 1, scope, allowed, memo)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether evaluating `complex` right to left gives the same result as
/// expanding it left to right: no leading combinator, no `:scope`, and no
/// positional pseudo-class, which filters each intermediate selection.
fn is_backward_safe(complex: &Complex) -> Result<bool> {
    if complex.leading.is_some() || complex.parts.len() < 2 {
        return Ok(false);
    }
    for part in &complex.parts {
        for test in part {
            if let Test::Pseudo(name, argument) = test {
                if name == "scope"
                    || position(name)
                    || (matches!(name.as_str(), "not" | "is" | "where" | "matches")
                        && has_position(argument)?)
                {
                    return Ok(false);
                }
            }
        }
    }
    Ok(true)
}

fn matches_expression<D: SelectDom>(dom: &D, id: u32, source: &str, scope: &[u32]) -> Result<bool> {
    for complex in parse(source)?.iter() {
        let mut memo = BackwardMemo::default();
        if matches_backwards(dom, id, complex, complex.parts.len() - 1, scope, &mut memo)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn pseudo<D: SelectDom>(
    dom: &D,
    id: u32,
    name: &str,
    argument: &str,
    scope: &[u32],
) -> Result<bool> {
    if let Some(result) = dom.custom_pseudo(id, name, Some(argument)) {
        return Ok(result);
    }
    if let Some(alias) = dom.pseudo_alias(name) {
        return matches_expression(dom, id, alias, scope);
    }
    let node_name = dom.name(id).unwrap_or("");
    Ok(match name {
        "not" => !matches_expression(dom, id, argument, scope)?,
        "is" | "where" | "matches" => matches_expression(dom, id, argument, scope)?,
        "has" => !select_in(dom, argument, Some(&[id]))?.is_empty(),
        "contains" | "icontains" => {
            let value = unescape(argument.trim_matches(['\'', '"']));
            let text = dom.text(id);
            if name == "icontains" {
                contains(&text.to_lowercase(), &value.to_lowercase())
            } else {
                contains(&text, &value)
            }
        }
        "root" => dom.parent(id).is_none_or(|parent| !tag(dom, parent)),
        "scope" => scope.contains(&id),
        "empty" | "parent" => {
            let empty = !dom
                .children(id)
                .iter()
                .any(|child| tag(dom, *child) || !dom.text(*child).is_empty());
            if name == "empty" {
                empty
            } else {
                !empty
            }
        }
        "first-child" | "last-child" | "only-child" | "nth-child" | "nth-last-child"
        | "first-of-type" | "last-of-type" | "only-of-type" | "nth-of-type"
        | "nth-last-of-type" => {
            let mut children = siblings(dom, id);
            if name.ends_with("of-type") {
                children.retain(|child| dom.name(*child) == Some(node_name));
            }
            let mut argument = argument;
            if let Some((formula, of)) = argument.split_once(" of ") {
                argument = formula;
                children = filter_in(dom, of, &children)?;
            }
            let Some(index) = children.iter().position(|child| *child == id) else {
                return Ok(false);
            };
            match name {
                "first-child" | "first-of-type" => index == 0,
                "last-child" | "last-of-type" => index + 1 == children.len(),
                "only-child" | "only-of-type" => children.len() == 1,
                _ => nth(argument, index, children.len(), name.contains("nth-last")),
            }
        }
        "header" => matches!(node_name, "h1" | "h2" | "h3" | "h4" | "h5" | "h6"),
        "input" => matches!(node_name, "input" | "textarea" | "select" | "button"),
        "button" => {
            node_name == "button"
                || (node_name == "input" && attr_matches(dom, id, "type", "=", "button", None))
        }
        "text" => {
            node_name == "input"
                && dom.attr(id, "type").is_none_or(|kind| {
                    kind.is_empty()
                        || if dom.xml_mode() {
                            kind == "text"
                        } else {
                            kind.eq_ignore_ascii_case("text")
                        }
                })
        }
        "checkbox" | "file" | "password" | "radio" | "reset" | "image" | "submit" => {
            attr_matches(dom, id, "type", "=", name, None)
        }
        "selected" => selected(dom, id),
        "checked" => {
            (node_name == "input"
                && dom.attr(id, "checked").is_some()
                && (attr_matches(dom, id, "type", "=", "checkbox", None)
                    || attr_matches(dom, id, "type", "=", "radio", None)))
                || selected(dom, id)
        }
        "disabled" => disabled(dom, id),
        "enabled" => !disabled(dom, id),
        "link" | "any-link" => {
            matches!(node_name, "a" | "area" | "link") && dom.attr(id, "href").is_some()
        }
        "visited" | "active" | "hover" | "focus" | "target" => false,
        "required" => {
            matches!(node_name, "input" | "select" | "textarea")
                && dom.attr(id, "required").is_some()
        }
        "optional" => {
            matches!(node_name, "input" | "select" | "textarea")
                && dom.attr(id, "required").is_none()
        }
        "read-only" => {
            dom.attr(id, "readonly").is_some() || !matches!(node_name, "input" | "textarea")
        }
        "read-write" => {
            matches!(node_name, "input" | "textarea")
                && dom.attr(id, "readonly").is_none()
                && !disabled(dom, id)
        }
        "lang" => {
            let language = unescape(argument.trim_matches(['\'', '"'])).to_ascii_lowercase();
            let mut current = Some(id);
            let mut matches = false;
            while let Some(id) = current {
                if let Some(value) = dom.attr(id, "lang").or_else(|| dom.attr(id, "xml:lang")) {
                    let value = value.to_ascii_lowercase();
                    matches = value == language || value.starts_with(&(language.clone() + "-"));
                    break;
                }
                current = dom.parent(id);
            }
            matches
        }
        name if position(name) => true,
        _ => return Err(invalid(format!("Unknown pseudo-class :{name}"))),
    })
}

/// The candidates of a compound that names an element type, from the tree's
/// name index; `matches_compound` still tests each one.
fn elements_named_by<'a, D: SelectDom>(dom: &'a D, tests: &[Test]) -> Option<&'a [u32]> {
    tests.iter().find_map(|test| match test {
        Test::Tag(name) => dom.elements_named(&name.to_ascii_lowercase()),
        _ => None,
    })
}

fn matches_compound<D: SelectDom>(dom: &D, id: u32, tests: &[Test], scope: &[u32]) -> Result<bool> {
    if !tag(dom, id) {
        return Ok(false);
    }
    for test in tests {
        let matched = match test {
            Test::Tag(name) => {
                if !dom.lower_case_tags() {
                    dom.name(id)
                        .is_some_and(|actual| equal_strings(actual, name))
                } else {
                    dom.name(id)
                        .is_some_and(|actual| equal_strings(actual, &name.to_ascii_lowercase()))
                }
            }
            Test::Id(value) => dom
                .attr(id, "id")
                .is_some_and(|actual| equal_strings(actual, value)),
            Test::Class(value) => dom.attr(id, "class").is_some_and(|classes| {
                classes
                    .split_ascii_whitespace()
                    .any(|class| equal_strings(class, value))
            }),
            Test::Attribute {
                name,
                op,
                value,
                flag,
            } => attr_matches(dom, id, name, op, value, *flag),
            Test::Pseudo(name, argument) => {
                if matches!(name.as_str(), "not" | "is" | "where" | "matches")
                    && has_position(argument)?
                {
                    true
                } else {
                    pseudo(dom, id, name, argument, scope)?
                }
            }
        };
        if !matched {
            return Ok(false);
        }
    }
    Ok(true)
}

fn apply<D: SelectDom>(dom: &D, ids: Vec<u32>, tests: &[Test], scope: &[u32]) -> Result<Vec<u32>> {
    let mut result = Vec::new();
    for id in ids {
        if matches_compound(dom, id, tests, scope)? {
            result.push(id);
        }
    }
    for test in tests {
        if let Test::Pseudo(name, argument) = test {
            if position(name) {
                let len = result.len() as i64;
                let requested = argument.parse::<i64>().unwrap_or(0);
                let requested = if requested < 0 {
                    len + requested
                } else {
                    requested
                };
                result = result
                    .into_iter()
                    .enumerate()
                    .filter_map(|(index, id)| {
                        let index = index as i64;
                        let include = match name.as_str() {
                            "first" => index == 0,
                            "last" => index == len - 1,
                            "eq" | "nth" => index == requested,
                            "lt" => index < requested,
                            "gt" => index > requested,
                            "even" => index % 2 == 0,
                            "odd" => index % 2 == 1,
                            _ => true,
                        };
                        include.then_some(id)
                    })
                    .collect();
            } else if matches!(name.as_str(), "not" | "is" | "where" | "matches")
                && has_position(argument)?
            {
                let wanted: IdSet<_> = filter_in(dom, argument, &result)?.into_iter().collect();
                result.retain(|id| wanted.contains(id) != (name == "not"));
            }
        }
    }
    Ok(result)
}

/// Query descendants of contexts (the root document when omitted).
/// Option-derived flags, read once per query rather than for every node tested.
struct Flagged<'a, D> {
    dom: &'a D,
    xml: bool,
    lower_tags: bool,
    lower_attributes: bool,
}

impl<'a, D: SelectDom> Flagged<'a, D> {
    fn new(dom: &'a D) -> Self {
        Self {
            dom,
            xml: dom.xml_mode(),
            lower_tags: dom.lower_case_tags(),
            lower_attributes: dom.lower_case_attribute_names(),
        }
    }
}

impl<D: SelectDom> SelectDom for Flagged<'_, D> {
    fn kind(&self, id: u32) -> &str {
        self.dom.kind(id)
    }
    fn name(&self, id: u32) -> Option<&str> {
        self.dom.name(id)
    }
    fn attr(&self, id: u32, name: &str) -> Option<&str> {
        self.dom.attr(id, name)
    }
    fn parent(&self, id: u32) -> Option<u32> {
        self.dom.parent(id)
    }
    fn children(&self, id: u32) -> &[u32] {
        self.dom.children(id)
    }
    fn text(&self, id: u32) -> String {
        self.dom.text(id)
    }
    fn xml_mode(&self) -> bool {
        self.xml
    }
    fn lower_case_tags(&self) -> bool {
        self.lower_tags
    }
    fn lower_case_attribute_names(&self) -> bool {
        self.lower_attributes
    }
    fn custom_pseudo(&self, id: u32, name: &str, argument: Option<&str>) -> Option<bool> {
        self.dom.custom_pseudo(id, name, argument)
    }
    fn pseudo_alias(&self, name: &str) -> Option<&str> {
        self.dom.pseudo_alias(name)
    }
    fn elements_named(&self, lowercase_name: &str) -> Option<&[u32]> {
        self.dom.elements_named(lowercase_name)
    }
    fn is_id_order_document_order(&self) -> bool {
        self.dom.is_id_order_document_order()
    }
}

pub(crate) fn select<D: SelectDom>(
    dom: &D,
    source: &str,
    contexts: Option<&[u32]>,
) -> Result<Vec<u32>> {
    select_in(&Flagged::new(dom), source, contexts)
}

/// Filter a supplied selection, applying positional pseudos to that selection.
pub(crate) fn filter<D: SelectDom>(dom: &D, source: &str, ids: &[u32]) -> Result<Vec<u32>> {
    filter_in(&Flagged::new(dom), source, ids)
}

fn select_in<D: SelectDom>(dom: &D, source: &str, contexts: Option<&[u32]>) -> Result<Vec<u32>> {
    let scope = contexts.unwrap_or(&[0]);
    let complexes = parse(source)?;
    // A compound over one subtree already follows DOM order. Avoid walking
    // the entire document again to sort an already ordered result.
    let ordered_compound = complexes.len() == 1
        && complexes[0].parts.len() == 1
        && complexes[0].leading.is_none()
        && scope.len() == 1;
    let mut result = Vec::new();
    let mut is_ordered = complexes.len() == 1 && scope.len() == 1;
    for complex in complexes.iter() {
        validate(dom, complex)?;
        if is_backward_safe(complex)? {
            // As in Cheerio, results lie within the scope, and elements matched
            // by earlier compounds may be the scope itself but not above it.
            // Candidates are in document order, and each is tested once.
            let last = complex.parts.len() - 1;
            let mut memo = BackwardMemo::default();
            if let Some(named) = (scope == [0] && !tag(dom, 0))
                .then(|| elements_named_by(dom, &complex.parts[last]))
                .flatten()
            {
                for id in named {
                    if matches_backwards_within(dom, *id, complex, last, scope, None, &mut memo)? {
                        result.push(*id);
                    }
                }
                continue;
            }
            if scope == [0] && !tag(dom, 0) {
                // Test each node while the walk has it in cache, without a candidate list.
                let mut failure = None;
                for_each_descendant(dom, 0, |id| {
                    match matches_backwards_within(dom, id, complex, last, scope, None, &mut memo) {
                        Ok(true) => result.push(id),
                        Ok(false) => {}
                        Err(error) => failure = Some(error),
                    }
                    failure.is_none()
                });
                if let Some(error) = failure {
                    return Err(error);
                }
                continue;
            }
            let candidates = descendants(dom, scope);
            let allowed: Option<IdSet<u32>> = (scope != [0] || tag(dom, 0))
                .then(|| scope.iter().chain(&candidates).copied().collect());
            for id in candidates {
                if matches_backwards_within(
                    dom,
                    id,
                    complex,
                    last,
                    scope,
                    allowed.as_ref(),
                    &mut memo,
                )? {
                    result.push(id);
                }
            }
            continue;
        }
        is_ordered &= ordered_compound;
        let named = (scope == [0] && complex.parts.len() == 1 && !tag(dom, 0))
            .then(|| elements_named_by(dom, &complex.parts[0]))
            .flatten();
        let mut candidates = if let Some(leading) = complex.leading {
            expand(dom, scope, leading)
        } else if let Some(named) = named {
            named.to_vec()
        } else {
            descendants(dom, scope)
        };
        if complex.parts[0]
            .iter()
            .any(|test| matches!(test,Test::Pseudo(name,_) if name=="scope"))
        {
            candidates = unique(scope.iter().copied().chain(candidates));
        }
        let mut current = apply(dom, candidates, &complex.parts[0], scope)?;
        for (index, part) in complex.parts.iter().enumerate().skip(1) {
            current = apply(
                dom,
                expand(dom, &current, complex.combinators[index - 1]),
                part,
                scope,
            )?;
        }
        result.extend(current);
    }
    if is_ordered {
        return Ok(result);
    }
    if dom.is_id_order_document_order() {
        result.sort_unstable();
        result.dedup();
        return Ok(result);
    }
    let wanted: IdSet<u32> = result.iter().copied().collect();
    // Stable IDs are allocation IDs after mutations; obtain actual DOM order.
    let ordered = descendants(dom, &[0]);
    let mut sorted: Vec<u32> = ordered
        .into_iter()
        .filter(|id| wanted.contains(id))
        .collect();
    let attached: IdSet<u32> = sorted.iter().copied().collect();
    sorted.extend(
        unique(result)
            .into_iter()
            .filter(|id| !attached.contains(id)),
    );
    Ok(sorted)
}

fn filter_in<D: SelectDom>(dom: &D, source: &str, ids: &[u32]) -> Result<Vec<u32>> {
    let mut wanted = IdSet::default();
    for complex in parse(source)?.iter() {
        validate(dom, complex)?;
        let candidates = if complex.parts.len() == 1 {
            apply(dom, ids.to_vec(), &complex.parts[0], ids)?
        } else {
            let mut result = Vec::new();
            let mut memo = BackwardMemo::default();
            for id in ids {
                if matches_backwards(dom, *id, complex, complex.parts.len() - 1, ids, &mut memo)? {
                    result.push(*id);
                }
            }
            result
        };
        wanted.extend(candidates);
    }
    Ok(ids
        .iter()
        .copied()
        .filter(|id| wanted.contains(id))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arena::parse_xml;
    use serde_json::json;

    fn fixture() -> crate::arena::DomArena {
        parse_xml("<main><ul id='list'><li class='a' data-n='A'>one</li><li class='b'>two <b>B</b></li><li class='a'>three</li><li>four</li></ul><p id='escaped:id'>end</p></main>",json!({"xmlMode":false,"_useHtmlParser2":true}))
    }

    #[test]
    fn selectors_and_combinators() {
        let dom = fixture();
        for (source, count) in [
            ("li", 4),
            ("main > ul > li.a", 2),
            ("li.a + li", 2),
            ("li.b ~ li", 2),
            ("ul:has(b)", 1),
            ("li:contains(two)", 1),
            ("li:not(.a)", 2),
            ("li:is(.a,.b)", 3),
            ("[data-n='a' i]", 1),
            ("#escaped\\:id", 1),
        ] {
            assert_eq!(select(&dom, source, None).unwrap().len(), count, "{source}");
        }
    }

    #[test]
    fn selectors_compare_logical_utf16_and_css_escape_values() {
        let high = crate::codec::from_units(&[0xd83d]);
        let low = crate::codec::from_units(&[0xde00]);
        let literal = crate::codec::encode_scalar('\u{e03d}');
        let dom = parse_xml(
            &format!("<main><p id='emoji' title='😀'>😀</p><p id='lone' title='{high}'>{high}</p><p id='literal' title='{literal}'>{literal}</p><p title='café'>text</p></main>"),
            json!({"xmlMode":false,"_useHtmlParser2":true,"__losslessUnicode":true}),
        );
        assert_eq!(
            select(&dom, &format!("p:contains('{high}')"), None)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            select(&dom, &format!("p[title^='{high}']"), None)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            select(&dom, &format!("p[title$='{low}']"), None)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            select(&dom, &format!("p[title*='{literal}']"), None)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            select(&dom, "p[title='\\d83d\\de00']", None).unwrap().len(),
            1
        );
        assert_eq!(select(&dom, "p:contains('\\d83d')", None).unwrap().len(), 2);
        assert_eq!(select(&dom, "p[title=CAFÉ i]", None).unwrap().len(), 1);
    }

    #[test]
    fn positional_and_structural() {
        let dom = fixture();
        for (source, count) in [
            ("li:first", 1),
            ("li:last", 1),
            ("li:eq(-1)", 1),
            ("li:lt(2)", 2),
            ("li:gt(1)", 2),
            ("li:even", 2),
            ("li:not(:first)", 3),
            ("li:nth-child(2n+1)", 2),
            ("li:nth-last-child(2)", 1),
            ("li:first-child", 1),
            ("li:last-child", 1),
            ("ul:only-child", 0),
        ] {
            assert_eq!(select(&dom, source, None).unwrap().len(), count, "{source}");
        }
    }

    #[test]
    fn scoped_and_relative_selection() {
        let dom = fixture();
        let ul = select(&dom, "ul", None).unwrap();
        assert_eq!(select(&dom, "> li", Some(&ul)).unwrap().len(), 4);
        assert_eq!(select(&dom, "main li", Some(&ul)).unwrap().len(), 0);
        assert_eq!(select(&dom, ":scope > li", Some(&ul)).unwrap().len(), 4);
        let ids = select(&dom, "li", None).unwrap();
        assert_eq!(filter(&dom, ":odd", &ids).unwrap(), vec![ids[1], ids[3]]);
        assert_eq!(
            filter(&dom, "li.a + li", &ids).unwrap(),
            vec![ids[1], ids[3]]
        );
    }
}
