//! Lossless JavaScript UTF-16 over valid Rust strings. Ordinary Unicode keeps
//! its original representation; lone surrogates use BMP private-use frames.
use napi::{Env, JsString, NapiRaw};
use serde_json::Value;

/// A string returned to JavaScript. V8 decodes UTF-8 slowly, so text is
/// handed over as Latin-1 when every character fits, which also keeps V8's
/// compact one-byte string, and as UTF-16 otherwise.
pub struct JsText(pub String);

impl napi::bindgen_prelude::ToNapiValue for JsText {
    unsafe fn to_napi_value(
        env: napi::sys::napi_env,
        value: Self,
    ) -> napi::Result<napi::sys::napi_value> {
        Ok(js_string(&Env::from_raw(env), &value.0)?.raw())
    }
}

pub(crate) fn js_string(env: &Env, text: &str) -> napi::Result<JsString> {
    if text.is_ascii() {
        env.create_string_latin1(text.as_bytes())
    } else if let Some(latin1) = latin1_bytes(text) {
        env.create_string_latin1(&latin1)
    } else {
        env.create_string_utf16(&utf16_units(text))
    }
}

/// `text` in Latin-1, if every character is below U+0100: UTF-8 encodes
/// those with lead bytes below 0xC4.
pub(crate) fn latin1_bytes(text: &str) -> Option<Vec<u8>> {
    if text.bytes().any(|byte| byte >= 0xC4) {
        return None;
    }
    Some(text.chars().map(|character| character as u8).collect())
}

/// `text` as UTF-16, widening eight ASCII bytes at a time and decoding other
/// characters directly from their UTF-8 bytes, which `text` guarantees valid.
pub(crate) fn utf16_units(text: &str) -> Vec<u16> {
    const HIGH_BITS: u64 = 0x8080_8080_8080_8080;
    let bytes = text.as_bytes();
    let mut units = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if let Some(chunk) = bytes.get(index..index + 8) {
            let word = u64::from_le_bytes(chunk.try_into().unwrap());
            if word & HIGH_BITS == 0 {
                units.extend(chunk.iter().map(|byte| u16::from(*byte)));
                index += 8;
                continue;
            }
        }
        let lead = u32::from(bytes[index]);
        let continuation = |offset: usize| u32::from(bytes[index + offset] & 0x3F);
        let (scalar, length) = match lead {
            0x00..=0x7F => (lead, 1),
            0x80..=0xDF => (((lead & 0x1F) << 6) | continuation(1), 2),
            0xE0..=0xEF => (
                ((lead & 0x0F) << 12) | (continuation(1) << 6) | continuation(2),
                3,
            ),
            _ => (
                ((lead & 0x07) << 18)
                    | (continuation(1) << 12)
                    | (continuation(2) << 6)
                    | continuation(3),
                4,
            ),
        };
        if scalar < 0x1_0000 {
            units.push(scalar as u16);
        } else {
            let offset = scalar - 0x1_0000;
            units.push(0xD800 | (offset >> 10) as u16);
            units.push(0xDC00 | (offset & 0x3FF) as u16);
        }
        index += length;
    }
    units
}

pub(crate) const ESCAPE: char = '\u{e800}';
pub(crate) fn is_reserved(ch: char) -> bool {
    ('\u{e000}'..=ESCAPE).contains(&ch)
}
pub(crate) fn has_encoding(value: &str) -> bool {
    // Every reserved character starts with the lead byte 0xEE in UTF-8, so a
    // byte search skips decoding the characters of ordinary text.
    memchr::memchr_iter(0xEE, value.as_bytes())
        .any(|index| value[index..].chars().next().is_some_and(is_reserved))
}
pub(crate) fn from_units(units: &[u16]) -> String {
    if units.iter().all(|unit| !(0xd800..=0xe800).contains(unit)) {
        return String::from_utf16_lossy(units);
    }
    let mut output = String::with_capacity(units.len());
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        if (0xd800..=0xdbff).contains(&unit)
            && units
                .get(index + 1)
                .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
        {
            let code =
                0x10000 + ((unit as u32 - 0xd800) << 10) + (units[index + 1] as u32 - 0xdc00);
            output.push(char::from_u32(code).unwrap());
            index += 2;
            continue;
        }
        if (0xd800..=0xdfff).contains(&unit) {
            output.push(char::from_u32(0xe000 + unit as u32 - 0xd800).unwrap());
        } else {
            let ch = char::from_u32(unit as u32).unwrap();
            if is_reserved(ch) {
                output.push(ESCAPE);
            }
            output.push(ch);
        }
        index += 1;
    }
    output
}
/// Receives the UTF-16 units of a string from [`visit_units`].
pub(crate) trait UnitSink {
    /// A run of ASCII bytes starting at byte offset `start`, one unit each.
    fn ascii(&mut self, start: usize, run: &[u8]);
    /// One unit and the byte offset of the character that starts there, or
    /// `None` for the low half of a surrogate pair.
    fn unit(&mut self, offset: Option<usize>, unit: u16);
}

impl UnitSink for Vec<u16> {
    fn ascii(&mut self, _: usize, run: &[u8]) {
        self.extend(run.iter().map(|value| u16::from(*value)));
    }
    fn unit(&mut self, _: Option<usize>, unit: u16) {
        self.push(unit);
    }
}

/// Feeds the UTF-16 units of `value` to `sink`. With `framed`, lossless frames
/// decode to their original units.
pub(crate) fn visit_units(value: &str, framed: bool, sink: &mut impl UnitSink) {
    let bytes = value.as_bytes();
    let mut byte = 0;
    while byte < bytes.len() {
        let ascii = bytes[byte..]
            .iter()
            .position(|value| !value.is_ascii())
            .unwrap_or(bytes.len() - byte);
        sink.ascii(byte, &bytes[byte..byte + ascii]);
        byte += ascii;
        let Some(ch) = value[byte..].chars().next() else {
            break;
        };
        let start = byte;
        byte += ch.len_utf8();
        if framed && ch == ESCAPE {
            if let Some(next) = value[byte..]
                .chars()
                .next()
                .filter(|next| is_reserved(*next))
            {
                sink.unit(Some(start), next as u16);
                byte += next.len_utf8();
                continue;
            }
        }
        if framed && ('\u{e000}'..ESCAPE).contains(&ch) {
            sink.unit(Some(start), 0xd800 + (ch as u16 - 0xe000));
            continue;
        }
        let mut encoded = [0; 2];
        let encoded = ch.encode_utf16(&mut encoded);
        sink.unit(Some(start), encoded[0]);
        if let Some(low) = encoded.get(1) {
            sink.unit(None, *low);
        }
    }
}
pub(crate) fn to_units(value: &str) -> Vec<u16> {
    let mut output = Vec::with_capacity(value.len());
    visit_units(value, has_encoding(value), &mut output);
    output
}
pub(crate) fn to_usv(value: &str) -> String {
    if has_encoding(value) {
        String::from_utf16_lossy(&to_units(value))
    } else {
        value.to_owned()
    }
}
pub(crate) fn encode_scalar(ch: char) -> String {
    let mut output = String::new();
    if is_reserved(ch) {
        output.push(ESCAPE);
    }
    output.push(ch);
    output
}
pub(crate) fn encode_literal(value: &str) -> String {
    if !has_encoding(value) {
        return value.to_owned();
    }
    let mut output = String::with_capacity(value.len());
    for ch in value.chars() {
        if is_reserved(ch) {
            output.push(ESCAPE);
        }
        output.push(ch);
    }
    output
}

/// JSON.parse accepts lone escaped UTF-16 units. serde_json's String decoder
/// requires scalar values, so translate only JSON unicode escape tokens first.
/// Raw characters are already encoded by the native transport and stay intact.
pub(crate) fn parse_json(source: &str) -> serde_json::Result<Value> {
    if !source.contains("\\u") {
        return serde_json::from_str(source);
    }
    let mut output = String::with_capacity(source.len());
    let bytes = source.as_bytes();
    let mut index = 0;
    let mut quoted = false;
    while index < source.len() {
        if bytes[index] == b'"' {
            quoted = !quoted;
            output.push('"');
            index += 1;
            continue;
        }
        if quoted && bytes[index] == b'\\' {
            if bytes.get(index + 1) == Some(&b'u') && index + 6 <= source.len() {
                if let Some(unit) = source
                    .get(index + 2..index + 6)
                    .and_then(|text| u16::from_str_radix(text, 16).ok())
                {
                    if (0xd800..=0xdbff).contains(&unit)
                        && source.get(index + 6..index + 8) == Some("\\u")
                    {
                        if let Some(next) = source
                            .get(index + 8..index + 12)
                            .and_then(|text| u16::from_str_radix(text, 16).ok())
                            .filter(|next| (0xdc00..=0xdfff).contains(next))
                        {
                            let _ = next;
                            output.push_str(&source[index..index + 12]);
                            index += 12;
                            continue;
                        }
                    }
                    if (0xd800..=0xdfff).contains(&unit) || (0xe000..=0xe800).contains(&unit) {
                        output.push_str(&from_units(&[unit]));
                        index += 6;
                        continue;
                    }
                }
            }
            output.push('\\');
            index += 1;
            if let Some(ch) = source[index..].chars().next() {
                output.push(ch);
                index += ch.len_utf8();
            }
            continue;
        }
        let ch = source[index..].chars().next().unwrap();
        output.push(ch);
        index += ch.len_utf8();
    }
    serde_json::from_str(&output)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn framing_preserves_all_utf16_units_and_literal_private_use() {
        let units = [0xd800, 0x41, 0xdfff, 0xe000, 0xe800, 0xd83d, 0xde00];
        assert_eq!(to_units(&from_units(&units)), units);
        assert_eq!(
            to_usv(&from_units(&units)),
            "\u{fffd}A\u{fffd}\u{e000}\u{e800}😀"
        );
    }
    #[test]
    fn json_data_decoding_preserves_escaped_units_and_literal_escape_sequences() {
        let value =
            parse_json(r#"{"a":"\ud800","b":"\ue000","c":"\\ud800","d":"\ud83d\ude00"}"#).unwrap();
        assert_eq!(to_units(value["a"].as_str().unwrap()), vec![0xd800]);
        assert_eq!(to_units(value["b"].as_str().unwrap()), vec![0xe000]);
        assert_eq!(value["c"], r"\ud800");
        assert_eq!(value["d"], "😀");
    }
}
