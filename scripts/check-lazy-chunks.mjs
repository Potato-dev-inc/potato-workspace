#!/usr/bin/env node
// After a production build: every lazy file-viewer chunk (DocxView, SheetView, PdfView, HtmlView, CodeEdit,
// SandboxFrame, CodeEditor) must load in a real browser from the built dist, the way the desktop app loads it.
// 1. Static: every chunk file exists, and every relative import inside it points at a file that exists.
// 2. Browser: serve dist (like the app's asset server does), open index.html in headless Edge, then run
//    `import(<chunk url>)` for each viewer chunk and fail if any import throws.
// Usage: node scripts/check-lazy-chunks.mjs [dist folder]   (default packages/app/dist)
// Run it after `npm run build` (release-build can call `npm run check:lazy-chunks`). Headless only; it only
// stops the Edge it started (found by its own temp profile folder).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EDGE_CANDIDATES = [
  process.env.PM_EDGE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const VIEWER = /^(DocxView|SheetView|PdfView|HtmlView|CodeEdit|CodeEditor|SandboxFrame)-[\w-]+\.js$/;
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The desktop app (Tauri) serves every asset with a type it GUESSES from the file's content first (the `infer` crate)
 * and only then from the extension. A script chunk that holds the text "%PDF" in its first 1024 bytes is guessed as
 * application/pdf, and the browser then refuses to load it as a module. Mirror the guess for the cases that matter.
 */
function sniff(buf, ext) {
  const head = buf.subarray(0, 1024);
  if (head.includes(Buffer.from('%PDF'))) return 'application/pdf';
  const start = buf.subarray(0, 64).toString('latin1').trimStart().toLowerCase();
  if (ext === '.js' && (start.startsWith('<') || start.startsWith('#!'))) return 'text/html';
  return null;
}

const dist = path.resolve(process.argv[2] ?? 'packages/app/dist');
const assets = path.join(dist, 'assets');
if (!existsSync(path.join(dist, 'index.html'))) {
  console.error(`FAIL: no index.html in ${dist} (run npm run build first)`);
  process.exit(1);
}
const chunks = readdirSync(assets).filter((f) => VIEWER.test(f));
const required = ['DocxView', 'SheetView', 'PdfView', 'HtmlView', 'CodeEdit'];
const problems = [];
for (const name of required) {
  if (!chunks.some((c) => c.startsWith(`${name}-`))) problems.push(`no ${name}-*.js chunk in dist/assets`);
}

// 1. Static import graph of every viewer chunk (and what it imports, recursively).
const seen = new Set();
function walk(file, from) {
  if (seen.has(file)) return;
  seen.add(file);
  const full = path.join(assets, file);
  if (!existsSync(full)) {
    problems.push(`${from} imports ${file}, which is not in dist/assets`);
    return;
  }
  const src = readFileSync(full, 'utf8');
  for (const m of src.matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)) walk(m[1], file);
}
for (const c of chunks) walk(c, '(entry)');
for (const f of readdirSync(assets).filter((n) => n.endsWith('.js'))) {
  const kind = sniff(readFileSync(path.join(assets, f)), '.js');
  if (kind) problems.push(`${f} would be served by the app as ${kind}, not as a script (the first 1024 bytes look like another file type)`);
}
console.log(`static: ${chunks.length} viewer chunks, ${seen.size} files in their import graph`);

// 2. Real browser.
const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!edge) {
  console.error('FAIL: Microsoft Edge not found (set PM_EDGE to its path)');
  process.exit(1);
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let file = path.join(dist, decodeURIComponent(url.pathname));
  const inside = file.startsWith(dist);
  if (!inside || !existsSync(file) || !statSync(file).isFile()) {
    // Like the desktop app's asset server: an unknown path answers with the HTML shell, so a missing chunk
    // fails the import with a wrong-type error instead of a 404.
    file = path.join(dist, 'index.html');
  }
  const body = readFileSync(file);
  const ext = path.extname(file);
  const type = sniff(body, ext) ?? MIME[ext] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const dbgPort = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const profile = mkdtempSync(path.join(tmpdir(), 'pm-lazy-chunks-'));
const killProfile = () => {
  if (process.platform !== 'win32') return;
  const needle = profile.replace(/'/g, "''");
  spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: 'ignore' });
};
let ws = null;
let results = [];
try {
  const child = spawn(edge, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${dbgPort}`, '--remote-allow-origins=*', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  child.unref();
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json`, { signal: AbortSignal.timeout(2000) })).json();
      target = list.find((t) => t.type === 'page') ?? null;
    } catch { /* not up yet */ }
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('headless Edge did not start');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send('Page.enable');
  await send('Page.navigate', { url: `http://localhost:${port}/` });
  await sleep(4000); // let the entry bundle run: lazy chunks import it, so it must be the same instance
  const expression = `(async () => {
    const out = [];
    for (const f of ${JSON.stringify(chunks)}) {
      try { await import('/assets/' + f); out.push({ f, ok: true }); }
      catch (e) { out.push({ f, ok: false, error: String(e && e.message || e) }); }
    }
    return JSON.stringify(out);
  })()`;
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  results = JSON.parse(r.result?.value ?? '[]');
} catch (err) {
  problems.push(`browser check could not run: ${err instanceof Error ? err.message : err}`);
} finally {
  try { ws?.close(); } catch { /* closing */ }
  await sleep(400);
  killProfile();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp */ }
  server.close();
}
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} import ${r.f}${r.ok ? '' : `  ${r.error}`}`);
  if (!r.ok) problems.push(`import(${r.f}) failed: ${r.error}`);
}
if (results.length === 0 && problems.length === 0) problems.push('browser check returned no results');
if (problems.length) {
  console.error(`FAIL:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`ok: ${results.length} lazy viewer chunks load from the built dist in headless Edge`);
process.exit(0);
