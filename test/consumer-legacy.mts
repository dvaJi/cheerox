// An ESM consumer of the cheerox root entry, type-checked both ways.
import cheerio, { load as legacyLoad, html as staticHtml, version } from 'cheerox';
import * as named from 'cheerox';

const $ = cheerio.load('<p>ESM default</p>');
const text: string = $('p').text();
const viaNamed: string = named.load('<p>Named</p>')('p').text();
const viaLoad: string = legacyLoad('<p>Load</p>')('p').text();
const versionText: string = version;
const outer: string = staticHtml($('p'));
void [text, viaNamed, viaLoad, versionText, outer];

// Modern extras are re-exported additively.
const info: number = named.configureWorkers({ threads: 2 }).threads;
void info;
named.extractAll(['<b>x</b>'], { text: 'b' }, { threads: 1 }).then((rows) => {
  const first: string | undefined = rows[0].text;
  void first;
});
