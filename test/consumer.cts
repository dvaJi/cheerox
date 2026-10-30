import rusteerio = require('rusteerio');
const $ = rusteerio.load('<p>CommonJS</p>');
const text: string = $('p').text();
void text;
