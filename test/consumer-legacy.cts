// A Cheerio 0.22.0-era CommonJS consumer, type-checked against cheerox.
import cheerio = require('@dvaji/cheerox');

const $ = cheerio.load('<ul id="fruits"><li class="apple">Apple</li></ul>');
const appleText: string = $('.apple').text();
const html: string = $.html();
const xml: string = cheerio.xml($.root());

// Callable module API without load()
const element = cheerio('<div class="item">Hello</div>');
const bareHtml: string = cheerio.html(element);
const version: string = cheerio.version;

// Legacy selector signatures
const contextual = $('.apple', 'ul');
const fromHtml = $('li', '<ul><li>Hello</li></ul>');
const withRoot = $('li', 'ul', '<ul><li>Hello</li></ul>');
void [appleText, html, xml, element, bareHtml, version, contextual, fromHtml, withRoot];

// Array-like selection behavior and prototype surface
const count: number = $('li').length;
const first: cheerio.LegacyNode | undefined = $('li')[0];
const all: cheerio.LegacyNode[] = $('li').toArray();
const prototyped = $('li').each(function (this: cheerio.LegacyNode, index: number) {
  const name: string | undefined = this.name;
  void [name, index];
});
const options: cheerio.LegacyOptions = $('li').options;
void [count, first, all, prototyped, options];

// Statics
const parsed = cheerio.parseHTML('<p>a</p><script>b</script>');
const root = cheerio.root.call(cheerio);
void [parsed, root];
