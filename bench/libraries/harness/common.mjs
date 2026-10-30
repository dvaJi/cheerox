import fs from 'node:fs';

export function loadCorpus(path = new URL('../corpus/pages.jsonl', import.meta.url), limit = Infinity) {
  // The corpus is larger than V8's max string length, so split the buffer by line.
  const buf = fs.readFileSync(path);
  const pages = [];
  for (let start = 0; start < buf.length && pages.length < limit;) {
    let end = buf.indexOf(10, start);
    if (end === -1) end = buf.length;
    if (end > start) pages.push(JSON.parse(buf.toString('utf8', start, end)).html);
    start = end + 1;
  }
  return pages;
}

// Peak and current resident set size of the whole process (all threads), in MB.
export function procMem() {
  const s = fs.readFileSync('/proc/self/status', 'utf8');
  const kb = (k) => Number(s.match(new RegExp(`${k}:\\s+(\\d+)`))[1]);
  return { rssMB: kb('VmRSS') / 1024, hwmMB: kb('VmHWM') / 1024 };
}

// Reset the VmHWM peak counter so the next reading reflects only what follows.
export function resetPeak() {
  try { fs.writeFileSync('/proc/self/clear_refs', '5'); return true; } catch { return false; }
}

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const bytes = (pages) => pages.reduce((n, p) => n + Buffer.byteLength(p), 0);
