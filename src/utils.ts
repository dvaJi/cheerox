import type { AnyNode, Element } from './types.js';
import type { Cheerio } from './selection.js';

export function isCheerio(value: unknown): value is Cheerio<AnyNode> {
  return value !== null && typeof value === 'object' && 'cheerio' in value;
}

export function camelCase(value: string): string {
  return value.replace(/[._-](\w|$)/g, (_match, character: string) => character.toUpperCase());
}

export function cssCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

export function domEach<T, A extends ArrayLike<T>>(array: A, callback: (element: T, index: number) => void): A {
  for (let index = 0; index < array.length; index += 1) callback(array[index], index);
  return array;
}

export function isHtml(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const start = value.indexOf('<');
  return start >= 0 && /[A-Za-z!]/.test(value[start + 1] ?? '') && value.indexOf('>', start + 2) >= 0;
}

export function isTag(node: AnyNode): node is Element {
  return node.type === 'tag' || node.type === 'script' || node.type === 'style';
}
