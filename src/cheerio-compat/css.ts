// Cheerio 0.22 style attribute parsing and mutation.
import type { LegacyNode } from './types.js';

export function setCss(el: LegacyNode, prop: any, val: any, idx: number): void {
  if (typeof prop === 'string') {
    const styles = parseStyles(el.attribs?.style);
    if (typeof val === 'function') {
      val = val.call(el, idx, styles[prop]);
    }

    if (val === '') {
      delete styles[prop];
    } else if (val != null) {
      styles[prop] = val;
    }

    el.attribs!.style = stringifyStyles(styles);
  } else if (typeof prop === 'object') {
    for (const key of Object.keys(prop)) {
      setCss(el, key, prop[key], idx);
    }
  }
}

export function getCss(el: LegacyNode | undefined, prop?: any): any {
  const styles = parseStyles(el?.attribs?.style);
  if (typeof prop === 'string') {
    return styles[prop];
  } else if (Array.isArray(prop)) {
    return pick(styles, prop);
  } else {
    return styles;
  }
}

function pick(obj: Record<string, string>, props: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const prop of props) if (prop in obj) result[prop] = obj[prop];
  return result;
}

function stringifyStyles(obj: Record<string, string>): string {
  return Object.keys(obj).reduce((str, prop) => `${str}${str ? ' ' : ''}${prop}: ${obj[prop]};`, '');
}

function parseStyles(styles: string | undefined): Record<string, string> {
  styles = (styles || '').trim();

  if (!styles) return {};

  return styles.split(';').reduce<Record<string, string>>((obj, str) => {
    const n = str.indexOf(':');
    // skip if there is no :, or if it is the first/last character
    if (n < 1 || n === str.length - 1) return obj;
    obj[str.slice(0, n).trim()] = str.slice(n + 1).trim();
    return obj;
  }, {});
}
