// Diagnostic counts only: do not use this instrumentation for timing.
import * as cheerox from '../dist/modern.mjs';
const cards = Number(process.argv[2] ?? 200);
if (!Number.isInteger(cards) || cards < 1) throw new Error('Expected a positive card count');
const html = '<main>' + Array.from({length: cards}, (_, i) => `<article><a href="/${i}">link</a><p>text ${i}</p></article>`).join('') + '</main>';
const cases = {
  select: $ => $('article a').length,
  filter: $ => $('a').filter('[href^="/1"]').length,
  attributes: $ => $('a').toArray().map(n => n.attribs.href).length,
  mutation: $ => { $('a').attr('data-x', '1'); return $('a[data-x]').length; },
  data: $ => { const n = $('a').first(); n.data('key', {text: '\ud800', literal: String.raw`\ud800`}); return n.data('key').text; },
  extract: $ => $.extract({ links: [{selector: 'a', value: 'href'}], text: ['p'] }),
};
const parse = JSON.parse, stringify = JSON.stringify;
for (const [name, fn] of Object.entries(cases)) {
  const $ = cheerox.load(html);
  const counts = { parseCalls: 0, parseBytes: 0, stringifyCalls: 0, stringifyBytes: 0 };
  try {
    JSON.parse = function (value, ...rest) { counts.parseCalls++; counts.parseBytes += Buffer.byteLength(String(value)); return Reflect.apply(parse, this, [value, ...rest]); };
    JSON.stringify = function (...args) { const result = Reflect.apply(stringify, this, args); counts.stringifyCalls++; if (typeof result === 'string') counts.stringifyBytes += Buffer.byteLength(result); return result; };
    fn($);
  } finally { JSON.parse = parse; JSON.stringify = stringify; }
  console.log(name, stringify(counts));
}
