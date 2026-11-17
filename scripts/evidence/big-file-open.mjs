#!/usr/bin/env node
// Measures how fast a big Word file opens in the file viewer, in headless Edge (no visible window), and shoots the
// result. It starts: a small file server with Range support on port 47891 (it plays the app's `pmfile` stream), this
// worktree's vite, and one headless Edge with a temp profile. It stops only those, by process id / profile path.
// Usage: node scripts/evidence/big-file-open.mjs --docx <file.docx> --out <dir> [--runs 3]
// Make the file with: node scripts/fixtures/big-docx/make-big-docx.mjs --mb 60 --out <file.docx>
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const appDir = path.join(root, 'packages/app');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const docx = arg('--docx');
const out = path.resolve(arg('--out', path.join(tmpdir(), 'big-file-open')));
const runs = Number(arg('--runs', 3));
if (!docx) {
  console.error('usage: node scripts/evidence/big-file-open.mjs --docx <file.docx> --out <dir> [--runs 3]');
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, 'localhost', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

// The file server: whole file or a Range, with CORS for the page.
const size = statSync(docx).size;
const served = { requests: 0, bytes: 0 };
const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges', 'Accept-Ranges': 'bytes' };
  served.requests++;
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  const suffix = m && m[1] === '' && m[2] !== '';
  const first = suffix ? Math.max(0, size - Number(m[2])) : m && m[1] !== '' ? Number(m[1]) : 0;
  const last = !suffix && m && m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
  served.bytes += last - first + 1;
  res.writeHead(m ? 206 : 200, {
    ...cors,
    'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'Content-Length': last - first + 1,
    ...(m ? { 'Content-Range': `bytes ${first}-${last}/${size}` } : {}),
  });
  createReadStream(docx, { start: first, end: last }).pipe(res);
});
await new Promise((r) => server.listen(47891, '127.0.0.1', r));

const PORT = await freePort();
const base = `http://localhost:${PORT}`;
const require = createRequire(path.join(appDir, 'package.json'));
const viteBin = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
const vite = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort', '--host', 'localhost'], { cwd: appDir, stdio: 'ignore', windowsHide: true });
const profile = mkdtempSync(path.join(tmpdir(), 'pm-bigfile-'));

function cleanup() {
  try {
    server.close();
  } catch {
    /* closing */
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    const needle = profile.replace(/'/g, "''");
    spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: 'ignore' });
  } else vite.kill();
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    /* best effort */
  }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));

for (let i = 0; i < 180; i++) {
  try {
    if ((await fetch(`${base}/src/main.tsx`, { signal: AbortSignal.timeout(5000) })).ok) break;
  } catch {
    /* not up yet */
  }
  await sleep(500);
}

const dbg = await freePort();
spawn(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${dbg}`, '--remote-allow-origins=*', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true }).unref();
let target = null;
for (let i = 0; i < 80 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${dbg}/json`, { signal: AbortSignal.timeout(2000) })).json();
    target = list.find((t) => t.type === 'page') ?? null;
  } catch {
    /* browser not up yet */
  }
  if (!target) await sleep(250);
}
if (!target) throw new Error('Edge did not start');
const ws = new WebSocket(target.webSocketDebuggerUrl);
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
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });

async function run(scenario) {
  await send('Page.navigate', { url: `${base}/?harness=${scenario}` });
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    try {
      const r = await send('Runtime.evaluate', { expression: 'window.__harnessReady === true', returnByValue: true });
      if (r.result?.value === true) break;
    } catch {
      /* page still navigating */
    }
  }
  const marks = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__bigMarks ?? null)', returnByValue: true });
  return JSON.parse(marks.result.value);
}

const results = [];
for (let i = 0; i < runs; i++) {
  const marks = await run('files-docx-big-light-900');
  results.push(marks);
  console.log(`run ${i + 1}:`, JSON.stringify(marks));
  if (i === 0) {
    await sleep(500);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(out, 'files-docx-big-light-900.png'), Buffer.from(shot.data, 'base64'));
  }
}
await run('files-too-big-light-900');
await sleep(500);
writeFileSync(path.join(out, 'files-too-big-light-900.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
writeFileSync(path.join(out, 'big-file-open.json'), JSON.stringify({ file: path.basename(docx), bytes: size, servedBytesTotal: served.bytes, requests: served.requests, results }, null, 2));
console.log(`server sent ${(served.bytes / 1048576).toFixed(1)} MB in ${served.requests} requests (${runs} opens + the too-big page)`);
console.log(`file ${(size / 1048576).toFixed(1)} MB`);
ws.close();
process.exit(0);
