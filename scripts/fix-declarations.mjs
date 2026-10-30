import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

// The declaration bundler can drop `type` when re-exporting classes or enums.
// Keep the public entry points faithful to source `export type` statements.
const typeOnly = new Set(['Cheerio', 'ElementType']);
for (const entry of ['index', 'slim', 'modern']) {
  for (const extension of ['d.ts', 'd.mts']) {
    const file = new URL(`../dist/${entry}.${extension}`, import.meta.url);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const source = ts.createSourceFile(file.pathname, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const edits = [];
    const found = new Set();
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
      for (const specifier of statement.exportClause.elements) {
        if (!typeOnly.has(specifier.name.text)) continue;
        found.add(specifier.name.text);
        if (!statement.isTypeOnly && !specifier.isTypeOnly) edits.push(specifier.getStart(source));
      }
    }
    // Entries that do not re-export these classes have nothing to fix.
    if (!edits.length) continue;
    for (const position of edits.sort((left, right) => right - left)) text = text.slice(0, position) + 'type ' + text.slice(position);
    if (edits.length) writeFileSync(file, text);
  }
}
