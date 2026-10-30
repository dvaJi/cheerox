import cheerox = require('@dvaji/cheerox/modern');
const $ = cheerox.load('<p>CommonJS</p>');
const text: string = $('p').text();
void text;
