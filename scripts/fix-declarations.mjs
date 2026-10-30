/**
 * The declaration bundler can drop `type` when re-exporting classes or
 * enums. Scan the public entry declarations and add `type ` to bare
 * specifiers of the known type-only names. Text-level on purpose: it must
 * not depend on a TypeScript compiler API whose shape changes across
 * compiler generations.
 *
 * Run: node scripts/fix-declarations.mjs (part of npm run build:ts)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const typeOnly = new Set(['Cheerio', 'ElementType']);
const entries = ['index', 'slim', 'modern'];
const dist = fileURLToPath(new URL('../dist/', import.meta.url));

let fixed = 0;
for (const entry of entries) {
  for (const extension of ['d.ts', 'd.mts', 'd.cts']) {
    const file = dist + `${entry}.${extension}`;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const updated = text.replace(/export\s*\{([^}]*)\}/g, (statement, specifiers) => {
      const parts = specifiers.split(',').map((part) => part.trim());
      const next = parts.map((part) => {
        const bare = typeOnly.has(part) ? `type ${part}` : part;
        if (bare !== part) fixed++;
        return bare;
      });
      return `export {${next.join(', ')}}`;
    });
    if (updated !== text) writeFileSync(file, updated);
  }
}
console.log(`fix-declarations: ${fixed} specifier(s) adjusted.`);
