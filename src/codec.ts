/**
 * Node strings use UTF-16, including unpaired surrogates. Rust strings use
 * Unicode scalar values. Reserve a small private-use alphabet on this private
 * boundary so neither representation loses a code unit.
 */
const reserved = /[\ud800-\ue800]/;
const encoded = /[\ue000-\ue800]/;
const escapeUnit = 0xe800;
const isWellFormed = (String.prototype as String & { isWellFormed?(): boolean }).isWellFormed;

export function encodeString(value: string): string {
  if (!encoded.test(value) && (isWellFormed ? isWellFormed.call(value) : !reserved.test(value))) return value;
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { index++; continue; }
    }
    let replacement: string | undefined;
    if (unit >= 0xd800 && unit <= 0xdfff) replacement = String.fromCharCode(0xe000 + unit - 0xd800);
    else if (unit >= 0xe000 && unit <= escapeUnit) replacement = '\ue800' + value[index];
    if (replacement !== undefined) {
      parts.push(value.slice(start, index), replacement);
      start = index + 1;
    }
  }
  return start === 0 ? value : parts.join('') + value.slice(start);
}

export function decodeString(value: string): string {
  if (!encoded.test(value)) return value;
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit < 0xe000 || unit > escapeUnit) continue;
    const next = value.charCodeAt(index + 1);
    if (unit === escapeUnit) {
      if (next < 0xe000 || next > escapeUnit || Number.isNaN(next)) continue;
      parts.push(value.slice(start, index), value[++index]);
    } else parts.push(value.slice(start, index), String.fromCharCode(0xd800 + unit - 0xe000));
    start = index + 1;
  }
  return start === 0 ? value : parts.join('') + value.slice(start);
}

// Transform JSON string tokens rather than the whole JSON text: JSON.stringify
// escapes lone surrogates, while a literal backslash-u sequence is plain data.
const encodeJsonCandidate = /[\ud800-\ue800]|\\u(?:d[89a-f][\da-f]{2}|e[0-8][\da-f]{2})/i;
const escapedJsonCandidate = /\\u(?:d[89a-f][\da-f]{2}|e[0-8][\da-f]{2})/i;
const decodeJsonCandidate = /[\ue000-\ue800]|\\ue[0-8][\da-f]{2}/i;

export function encodeJson(value: string): string {
  if (!encodeJsonCandidate.test(value)) return value;
  if (isWellFormed?.call(value) && !encoded.test(value) && !escapedJsonCandidate.test(value)) return value;
  return mapJsonStrings(value, encodeString);
}

export function decodeJson(value: string): string {
  return decodeJsonCandidate.test(value) ? mapJsonStrings(value, decodeString) : value;
}

/**
 * Replaces every string token of the JSON text `json` with `transform` of its
 * value, in one left-to-right pass. A regular expression scanning for tokens
 * retries from every quote of an unterminated token, which is quadratic.
 */
function mapJsonStrings(json: string, transform: (value: string) => string): string {
  const parts: string[] = [];
  let copied = 0;
  let quote = json.indexOf('"');
  while (quote !== -1) {
    let end = quote + 1;
    while (end < json.length && json.charCodeAt(end) !== 0x22) end += json.charCodeAt(end) === 0x5c ? 2 : 1;
    if (end >= json.length) break;
    parts.push(json.slice(copied, quote), JSON.stringify(transform(JSON.parse(json.slice(quote, end + 1)))));
    copied = end + 1;
    quote = json.indexOf('"', copied);
  }
  return copied === 0 ? json : parts.join('') + json.slice(copied);
}

/** Private parser protocol flag, appended without deserializing large options. */
export function encodeOptions(value?: string): string {
  if (value === undefined) return '{"__utf16Codec":true}';
  const json = encodeJson(value);
  if (!json.trimStart().startsWith('{')) return '{"__utf16Codec":true}';
  const end = json.lastIndexOf('}');
  const prefix = json.slice(0, end);
  return prefix + (prefix.trimEnd().endsWith('{') ? '' : ',') + '"__utf16Codec":true' + json.slice(end);
}
