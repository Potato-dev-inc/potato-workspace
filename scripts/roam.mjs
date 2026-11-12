#!/usr/bin/env node
// Screen scan: renders every harness scenario headless (dark, light, and 560 px wide), reads the visible text
// and applies the word rules in packages/app/src/lib/roam-rules.ts (banned words, raw errors, backticks,
// "dev build", codes in capitals, two names for one thing) plus three checks that need a layout (a button
// with no label, a label cut by its box, a page wider than the window). Writes a markdown report and a
// screenshot per screen and variant. Exits 1 on any hit that is not on the allow list (scripts/roam-allow.json).
//
// Usage: node scripts/roam.mjs [--out <dir>] [--only <regex>] [--variants dark,light,narrow] [--jobs 3] [--port <p>]
// Headless only: no window is ever opened. Edge profiles are temp folders and are removed on exit.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EDGE = process.env.ROAM_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(root, 'packages/app');
const scenarioDir = path.join(appDir, 'src/dev/scenarios');
const ALLOW_FILE = path.join(root, 'scripts/roam-allow.json');
const USAGE = 'usage: node scripts/roam.mjs [--out <dir>] [--only <regex>] [--variants dark,light,narrow] [--jobs 3] [--port <p>]';

const NARROW_PX = 560;
const VARIANTS = {
  dark: { theme: 'dark', width: null },
  light: { theme: 'light', width: null },
  narrow: { theme: 'dark', width: NARROW_PX },
};

const argv = process.argv.slice(2);
const opt = { out: path.join(tmpdir(), 'pm-roam'), only: null, variants: ['dark', 'light', 'narrow'], jobs: 3, port: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') opt.out = argv[++i];
  else if (a === '--only') opt.only = new RegExp(argv[++i]);
  else if (a === '--variants') opt.variants = argv[++i].split(',');
  else if (a === '--jobs') opt.jobs = Math.max(1, Number(argv[++i]) || 1);
  else if (a === '--port') opt.port = Number(argv[++i]);
  else {
    console.error(USAGE);
    process.exit(2);
  }
}
for (const v of opt.variants) {
  if (!(v in VARIANTS)) {
    console.error(`unknown variant "${v}"\n${USAGE}`);
    process.exit(2);
  }
}
opt.out = path.resolve(opt.out);
mkdirSync(opt.out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, 'localhost', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ---- rules: bundle the TypeScript module with esbuild (it ships with vite) so node can import it ----
const requireApp = createRequire(path.join(appDir, 'package.json'));
const esbuild = requireApp('esbuild');
const rulesOut = path.join(opt.out, '.roam-rules.mjs');
esbuild.buildSync({
  entryPoints: [path.join(appDir, 'src/lib/roam-rules.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: rulesOut,
  logLevel: 'silent',
});
const { checkTexts, applyAllow, checkAllowList, cell, ROAM_RULES } = await import(pathToFileURL(rulesOut).href);

const allow = existsSync(ALLOW_FILE) ? JSON.parse(readFileSync(ALLOW_FILE, 'utf8')) : [];
const allowProblems = checkAllowList(allow);
if (allowProblems.length) {
  console.error(`scripts/roam-allow.json:\n  ${allowProblems.join('\n  ')}`);
  process.exit(2);
}

// ---- scenarios ----
const scenarioNames = readdirSync(scenarioDir)
  .filter((f) => f.endsWith('.ts') && f !== 'index.ts' && !f.endsWith('.test.ts'))
  .map((f) => f.replace(/\.ts$/, ''))
  .filter((n) => !opt.only || opt.only.test(n))
  .sort();

/** Window size for a scenario, read from its file (same convention as scripts/evidence/screenshot.mjs). */
function sizeFor(name) {
  try {
    const src = readFileSync(path.join(scenarioDir, `${name}.ts`), 'utf8');
    const m = /window:\s*\{\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}/.exec(src);
    if (m) return { width: +m[1], height: +m[2] };
    if (/route:\s*'phone'/.test(src)) return { width: 390, height: 844 };
  } catch {
    /* default size */
  }
  return { width: 1440, height: 900 };
}

const jobs = [];
for (const name of scenarioNames) {
  const size = sizeFor(name);
  for (const variant of opt.variants) {
    const v = VARIANTS[variant];
    if (v.width && size.width <= v.width) continue; // already narrow: the plain run covers it
    jobs.push({ name, variant, theme: v.theme, width: v.width ?? size.width, height: size.height });
  }
}
if (!jobs.length) {
  console.error('no scenario matched');
  process.exit(2);
}

// ---- dev server (this worktree's own vite, verified by a per-run token) ----
const PORT = opt.port ?? (await freePort());
const base = `http://localhost:${PORT}`;
const TOKEN = randomBytes(16).toString('hex');
const viteBin = path.join(path.dirname(requireApp.resolve('vite/package.json')), 'bin/vite.js');
const vite = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort', '--host', 'localhost'], {
  cwd: appDir,
  env: { ...process.env, VITE_PM_EVIDENCE_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let viteExited = false;
vite.on('exit', () => (viteExited = true));
function stopVite() {
  if (viteExited) return;
  viteExited = true;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { windowsHide: true });
  else vite.kill();
}

const liveProfiles = new Set();
function killProfile(profile) {
  if (process.platform !== 'win32') return;
  const needle = profile.replace(/'/g, "''");
  spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
}
function cleanupProfile(profile) {
  killProfile(profile);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch {
    /* a leftover temp folder is harmless; never let cleanup hide the real result */
  }
  liveProfiles.delete(profile);
}
process.on('exit', () => {
  for (const p of liveProfiles) {
    try {
      cleanupProfile(p);
    } catch {
      /* best effort */
    }
  }
  stopVite();
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(sig === 'SIGINT' ? 130 : 143));
process.on('uncaughtException', (err) => {
  console.error(err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error(err);
  process.exit(1);
});

async function verifyOwnServer(timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !viteExited) {
    try {
      const res = await fetch(`${base}/src/main.tsx`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok && (await res.text()).includes(`"VITE_PM_EVIDENCE_TOKEN": "${TOKEN}"`)) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}
if (!(await verifyOwnServer())) {
  console.error('the dev server did not start');
  process.exit(1);
}

// ---- in-page extraction ----
/* eslint-disable */
function extractInPage() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);
  const texts = [];
  const seen = new Set();
  const push = (t) => {
    t = t.replace(/\s+/g, ' ').trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      texts.push(t);
    }
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = n.parentElement;
    if (p && !SKIP.has(p.tagName) && visible(p)) push(n.nodeValue || '');
  }
  for (const el of document.querySelectorAll('[aria-label],[title],[placeholder],[alt]')) {
    if (!visible(el)) continue;
    for (const a of ['aria-label', 'title', 'placeholder', 'alt']) push(el.getAttribute(a) || '');
  }
  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    const parent = el.parentElement ? el.parentElement.tagName.toLowerCase() : '';
    return `<${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}> in <${parent}>`;
  };
  const structural = [];
  for (const el of document.querySelectorAll('button,[role="button"],[role="tab"],a[href]')) {
    if (!visible(el)) continue;
    const named = (el.textContent || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('aria-labelledby');
    if (!named) structural.push({ rule: 'icon-button-no-label', text: describe(el) });
  }
  const clippedSeen = new Set();
  for (const el of document.body.querySelectorAll('*')) {
    if (SKIP.has(el.tagName) || !visible(el)) continue;
    const cs = getComputedStyle(el);
    if (!/hidden|clip/.test(cs.overflowX) || cs.textOverflow === 'ellipsis') continue;
    if (el.scrollWidth <= el.clientWidth + 2) continue;
    const own = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.nodeValue || '').join(' ').replace(/\s+/g, ' ').trim();
    if (!own) continue;
    const key = own.slice(0, 80);
    if (clippedSeen.has(key)) continue;
    clippedSeen.add(key);
    structural.push({ rule: 'clipped', text: `${own.slice(0, 100)}  (cut by its box, ${el.scrollWidth}px in ${el.clientWidth}px)` });
  }
  const root = document.documentElement;
  if (root.scrollWidth > window.innerWidth + 2) {
    structural.push({ rule: 'page-overflow', text: `page is ${root.scrollWidth}px wide in a ${window.innerWidth}px window` });
  }
  return { texts, structural, bodyLength: (document.body.innerText || '').trim().length };
}
/* eslint-enable */

// ---- one browser per worker, driven over the DevTools protocol ----
async function openBrowser() {
  const profile = mkdtempSync(path.join(tmpdir(), 'pm-roam-'));
  liveProfiles.add(profile);
  const dbgPort = await freePort();
  spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-dark-mode',
      `--remote-debugging-port=${dbgPort}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  ).unref();
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json`, { signal: AbortSignal.timeout(2_000) })).json();
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
  let exceptions = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      exceptions.push(String(d.exception?.description || d.text || 'exception').split('\n')[0]);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send('Page.enable');
  await send('Runtime.enable');
  return {
    send,
    takeExceptions: () => {
      const e = exceptions;
      exceptions = [];
      return e;
    },
    async close() {
      try {
        ws.close();
      } catch {
        /* closing */
      }
      await sleep(300);
      cleanupProfile(profile);
    },
  };
}

async function runJob(browser, job) {
  const { send } = browser;
  const result = { ...job, hits: [], texts: [], png: null };
  browser.takeExceptions();
  await send('Emulation.setDeviceMetricsOverride', { width: job.width, height: job.height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${base}/?harness=${encodeURIComponent(job.name)}&theme=${job.theme}` });
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    await sleep(500);
    try {
      const r = await send('Runtime.evaluate', { expression: 'window.__harnessReady === true', returnByValue: true });
      ready = r.result?.value === true;
    } catch {
      /* page still navigating */
    }
  }
  if (!ready) {
    result.hits.push({ rule: 'not-rendered', text: 'the scenario never finished loading (no __harnessReady in 40 s)' });
    return result;
  }
  await sleep(500);
  const r = await send('Runtime.evaluate', { expression: `(${extractInPage.toString()})()`, returnByValue: true });
  const page = r.result?.value;
  if (!page) {
    result.hits.push({ rule: 'not-rendered', text: 'could not read the page' });
    return result;
  }
  if (page.bodyLength === 0) result.hits.push({ rule: 'not-rendered', text: 'the screen has no text' });
  result.texts = page.texts;
  result.hits.push(...checkTexts(page.texts, job.name));
  for (const s of page.structural) result.hits.push(s);
  for (const e of browser.takeExceptions()) result.hits.push({ rule: 'js-error', text: e.slice(0, 160) });
  const dir = path.join(opt.out, job.variant);
  mkdirSync(dir, { recursive: true });
  const png = path.join(dir, `${job.name}.png`);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(png, Buffer.from(shot.data, 'base64'));
  result.png = png;
  return result;
}

// Throwaway first load so vite compiles the module graph before the real runs.
let warmUp;
const warmed = new Promise((resolve) => (warmUp = resolve));
const queue = [...jobs];
const results = [];
let done = 0;
async function worker(id) {
  let browser = null;
  try {
    browser = await openBrowser();
    if (id === 0) {
      // The first load makes vite compile the module graph; the other browsers wait for it.
      await browser.send('Page.navigate', { url: `${base}/?harness=${encodeURIComponent(jobs[0].name)}` });
      for (let i = 0; i < 360; i++) {
        const r = await browser.send('Runtime.evaluate', { expression: 'window.__harnessReady === true', returnByValue: true }).catch(() => null);
        if (r?.result?.value === true) break;
        await sleep(500);
      }
      warmUp();
    } else {
      await warmed;
    }
    for (let job = queue.shift(); job; job = queue.shift()) {
      let res = null;
      for (let attempt = 1; attempt <= 2 && !res; attempt++) {
        try {
          res = await runJob(browser, job);
        } catch (err) {
          if (attempt === 2) res = { ...job, hits: [{ rule: 'not-rendered', text: `scan error: ${err instanceof Error ? err.message : err}` }], texts: [], png: null };
        }
      }
      results.push(res);
      done++;
      if (done % 25 === 0 || done === jobs.length) console.log(`${done}/${jobs.length}`);
    }
  } catch (err) {
    console.error(`worker ${id}: ${err instanceof Error ? err.stack : err}`);
  } finally {
    if (id === 0) warmUp();
    await browser?.close();
  }
}
console.log(`roam: ${scenarioNames.length} scenarios, ${jobs.length} screens (${opt.variants.join(', ')}), ${opt.jobs} browsers`);
await Promise.all(Array.from({ length: Math.min(opt.jobs, jobs.length) }, (_, i) => worker(i)));

// ---- report ----
results.sort((a, b) => (a.name === b.name ? a.variant.localeCompare(b.variant) : a.name.localeCompare(b.name)));
const open = [];
let allowedCount = 0;
for (const r of results) {
  const split = applyAllow(r.hits, r.name, allow);
  allowedCount += split.allowed.length;
  for (const h of split.open) open.push({ screen: `${r.name} (${r.variant})`, rule: h.rule, text: h.text, png: r.png });
}
const byRule = Object.fromEntries(ROAM_RULES.map((rule) => [rule, open.filter((h) => h.rule === rule).length]));
const screensWithHits = new Set(open.map((h) => h.screen)).size;

const lines = [
  '# Screen scan',
  '',
  `${scenarioNames.length} scenarios, ${results.length} screens (${opt.variants.join(', ')}). ${open.length} open hits on ${screensWithHits} screens, ${allowedCount} allowed.`,
  '',
  '| Rule | Open hits |',
  '|---|---|',
  ...ROAM_RULES.map((rule) => `| ${rule} | ${byRule[rule]} |`),
  '',
  '## Hits',
  '',
  '| Screen | Rule | Text | Screenshot |',
  '|---|---|---|---|',
  ...open.map((h) => `| ${cell(h.screen)} | ${h.rule} | ${cell(h.text)} | ${h.png ? cell(h.png.replace(/\\/g, '/')) : ''} |`),
  '',
];
const reportPath = path.join(opt.out, 'roam-report.md');
writeFileSync(reportPath, lines.join('\n'));
writeFileSync(path.join(opt.out, 'roam-report.json'), JSON.stringify({ byRule, open, allowed: allowedCount, screens: results.length }, null, 2));
rmSync(rulesOut, { force: true });

console.log(`\n${open.length} open hits on ${screensWithHits} screens (${allowedCount} allowed)`);
for (const rule of ROAM_RULES) if (byRule[rule]) console.log(`  ${rule}: ${byRule[rule]}`);
console.log(`report: ${reportPath}`);
process.exit(open.length ? 1 : 0);
