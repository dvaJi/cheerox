/**
 * The pseudo-classes css-select 1.2.0 (Cheerio 0.22.0's selector engine)
 * understands; anything else throws, exactly as the original library did.
 */
const legacyPseudos = new Set([
  // filters
  'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type',
  'first-child', 'last-child', 'first-of-type', 'last-of-type',
  'only-of-type', 'only-child',
  // pseudos and jQuery extensions of the time
  'empty', 'link', 'visited', 'selected', 'disabled', 'enabled', 'checked',
  'required', 'optional', 'parent', 'header', 'button', 'input', 'text',
  'contains', 'icontains', 'checkbox', 'file', 'password', 'radio', 'reset',
  'image', 'submit', 'root', 'not', 'has', 'matches', 'scope',
]);

/** Reject pseudo-classes that only exist in later Cheerio lines. */
export function validateLegacySelector(selector: string): void {
  let depth = 0;
  let quote = '';
  let escape = false;
  for (let i = 0; i < selector.length; i++) {
    const character = selector[i];
    if (escape) { escape = false; continue; }
    if (character === '\\') { escape = true; continue; }
    if (quote) { if (character === quote) quote = ''; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '[') { depth++; continue; }
    if (character === ']') { depth = Math.max(0, depth - 1); continue; }
    if (depth || character !== ':') continue;
    const match = /^:([a-zA-Z][a-zA-Z0-9-]*)/.exec(selector.slice(i));
    if (!match) continue;
    if (!legacyPseudos.has(match[1])) {
      throw new SyntaxError(`unmatched pseudo-class ${match[0]}`);
    }
    // Skip a balanced argument so nested selectors are not scanned twice.
    if (selector[i + match[0].length] === '(') {
      let parens = 0;
      let innerQuote = '';
      for (let j = i + match[0].length; j < selector.length; j++) {
        const inner = selector[j];
        if (innerQuote) { if (inner === innerQuote) innerQuote = ''; continue; }
        if (inner === '"' || inner === "'") { innerQuote = inner; continue; }
        if (inner === '(') parens++;
        else if (inner === ')') { parens--; if (!parens) { i = j; break; } }
      }
    } else {
      i += match[0].length;
    }
  }
}
