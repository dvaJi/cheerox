'use strict';
// Runs the vendored Cheerio 0.22.0 suite (test/legacy) against the built
// package. The suite is executed as close to upstream as possible: original
// Mocha runner, original assertions.
module.exports = {
  spec: [
    'test/legacy/cheerio.js',
    'test/legacy/parse.js',
    'test/legacy/xml.js',
    'test/legacy/api/*.js',
  ],
  reporter: 'spec',
  timeout: 20000,
};

