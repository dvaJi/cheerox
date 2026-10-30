// Public Cheerio tests are run against the built cheerox package.
export * from '../../dist/modern.mjs';
// Cheerio itself only exports this class as a type. Upstream tests use its
// runtime identity to check the prototype chain.
import { load } from '../../dist/modern.mjs';
export const Cheerio = Object.getPrototypeOf(load([]).fn).constructor;
