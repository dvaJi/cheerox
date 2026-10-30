// Public Cheerio tests are run against the built rusteerio package.
export * from '../../dist/index.mjs';
// Cheerio itself only exports this class as a type. Upstream tests use its
// runtime identity to check the prototype chain.
import { load } from '../../dist/index.mjs';
export const Cheerio = Object.getPrototypeOf(load([]).fn).constructor;
