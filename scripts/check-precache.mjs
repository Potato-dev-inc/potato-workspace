#!/usr/bin/env node
// After a build: the service worker's precache list must not hold the desktop-only file viewer chunks.
// Usage: node scripts/check-precache.mjs [dist folder]   (default packages/app/dist)
import { readFileSync } from 'node:fs';
import path from 'node:path';

const dist = path.resolve(process.argv[2] ?? 'packages/app/dist');
const sw = readFileSync(path.join(dist, 'sw.js'), 'utf8');
const urls = [...sw.matchAll(/"?url"?:\s*"([^"]+)"/g)].map((m) => m[1]);
const banned = /(?:^|\/)(DocxView|SheetView|PdfView|HtmlView|SandboxFrame|CodeEdit)-[^/]*\.js$/;
const bad = urls.filter((u) => banned.test(u));
const size = urls.reduce((n, u) => {
  try {
    return n + readFileSync(path.join(dist, u)).length;
  } catch {
    return n;
  }
}, 0);
console.log(`precache: ${urls.length} entries, ${(size / 1024).toFixed(0)} KiB`);
if (bad.length || urls.length === 0) {
  console.error(`FAIL: viewer chunks in the precache list: ${bad.join(', ') || '(no entries found)'}`);
  process.exit(1);
}
console.log('ok: no file viewer chunk is precached');
