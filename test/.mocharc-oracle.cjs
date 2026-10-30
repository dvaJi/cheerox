'use strict';
// Runs the identical Cheerio 0.22.0 suite against the reference package
// (cheerio-legacy-reference = cheerio@0.22.0) to record the oracle's own
// pass/fail baseline. The suite files themselves are materialized into
// test/legacy-oracle/ by scripts/write-legacy-oracle.mjs.
module.exports = {
  spec: [
    'test/legacy-oracle/cheerio.js',
    'test/legacy-oracle/parse.js',
    'test/legacy-oracle/xml.js',
    'test/legacy-oracle/api/*.js',
  ],
  reporter: 'spec',
  timeout: 20000,
};
