import { createHash } from 'node:crypto';

/** Deterministic generated news/catalog documents; no network input or timing. */
export function documentOf(count, variant = 0, xml = false) {
  if (xml) return '<?xml version="1.0"?><Feed>' + Array.from({ length: count }, (_, index) =>
    `<Item Id="${index}"><Title>Entry ${index} &amp; café</Title><Link href="/entry/${variant}/${index}"/><Body><![CDATA[Some <formatted> text]]></Body></Item>`,
  ).join('') + '</Feed>';
  return '<!doctype html><html><head><meta charset="utf-8"><title>Generated news and catalog</title></head><body><header><nav><a href="/">Home</a></nav></header><main>' + Array.from({ length: count }, (_, index) =>
    `<article class="card ${index % 3 === 0 ? 'featured' : ''}" data-id="${index}"><h2>Entry ${index} &amp; café ${variant}</h2><p>Useful <strong>text</strong> with λ and 中文.</p><a href="/entry/${variant}/${index}">Read more</a>${index % 5 === 0 ? '<table><tbody><tr><td>Category</td><td>News</td></tr></tbody></table>' : ''}<ul><li>One</li><li>Two</li></ul></article>`,
  ).join('') + '</main><footer>Generated fixture</footer></body></html>';
}

export function extractionMap() {
  return { titles: ['article h2'], links: [{ selector: 'article a', value: 'href' }] };
}

// Extraction callbacks receive the DOM node, key, and current data object. A
// plain function avoids transferring closures between main and worker threads.
export function callbackMap() {
  return { rows: [{ selector: 'article', value: {
    title: 'h2', link: { selector: 'a', value: 'href' },
    id: { selector: 'h2', value: (element) => element.parent.attribs['data-id'] },
  } }] };
}

export function mapFor(mode) { return mode === 'nestedCallback' ? callbackMap() : extractionMap(); }

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export function digest(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }

export function runSync(api, mode, count, input) {
  const xml = mode === 'xml';
  const $ = api.load(input ?? documentOf(count, 0, xml), xml ? { xml: true } : undefined);
  if (mode === 'query') return { count: $('article.featured').length, title: $('h2').first().text(), last: $('article a').last().attr('href') };
  if (mode === 'mutations') {
    $('article').addClass('processed').attr('data-state', 'done');
    $('article.featured').removeClass('featured'); $('article h2').text('Updated');
    $('article').first().append('<p>Added</p>'); return $.html();
  }
  if (mode === 'xml') {
    $('Item').attr('State', 'ready'); $('Item').first().append('<Child/>');
    return { count: $('Item:contains(café)').length, output: $.xml() };
  }
  if (mode === 'crossDocument') {
    const target = api.load('<section></section>'); const retained = $('article');
    target('section').append(retained); retained.first().attr('moved', 'yes');
    return { source: $.html(), target: target.html(), text: retained.first().text() };
  }
  throw new Error(`Unknown sync workload ${mode}`);
}

export function streamSummary($, xml) {
  return xml
    ? { count: $('Item').length, first: $('Title').first().text(), last: $('Link').last().attr('href') }
    : { count: $('article').length, first: $('h2').first().text(), last: $('article a').last().attr('href') };
}
