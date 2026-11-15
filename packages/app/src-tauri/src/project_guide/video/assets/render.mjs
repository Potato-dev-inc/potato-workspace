// Draws the tour frame by frame in a headless Chromium/Edge and pipes the frames into ffmpeg. No packages: Node's own
// fetch and WebSocket. Everything stays on this PC (the browser listens on loopback only; nothing is fetched).
// usage: node render.mjs --stage <html> --out <mp4> --browser <exe> --ffmpeg <exe> [--aspect landscape|vertical] [--scale 1] [--fps 24]
// Prints `P <done> <total>` lines while it works and `DONE` at the end; on a problem it prints `ERR <text>` and exits 1.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const vertical = args.aspect === 'vertical';
const scale = Number(args.scale || 1);
const fps = Number(args.fps || 24);
let browser = null, ffmpeg = null, profile = null, closer = null;
function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}
// Anything still holding our own (random-named) profile folder is ours: a helper of the browser we started.
function killByProfile() {
  const name = path.basename(profile);
  if (process.platform === 'win32') {
    const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${name}*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true });
  } else spawnSync('pkill', ['-9', '-f', name], { stdio: 'ignore' });
}
// Edge and Chrome may hand the work to a process we did not start, so the browser is asked to close itself first.
async function cleanup() {
  killTree(ffmpeg);
  if (closer) { try { await Promise.race([closer(), new Promise((r) => setTimeout(r, 1500))]); } catch { /* closing anyway */ } }
  await new Promise((r) => setTimeout(r, 700));
  killTree(browser);
  if (profile) killByProfile();
  if (profile) {
    for (let i = 0; i < 12; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 400)); }
    }
  }
}
const fail = async (msg) => { console.log('ERR ' + String(msg).replace(/\s+/g, ' ').slice(0, 300)); await cleanup(); process.exit(1); };
process.on('SIGTERM', () => { cleanup().finally(() => process.exit(1)); });

for (const k of ['stage', 'out', 'browser', 'ffmpeg']) if (!args[k]) await fail(`missing --${k}`);

profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-guide-video-'));
browser = spawn(args.browser, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking', '--force-device-scale-factor=1',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore', windowsHide: true });

// Chromium writes the port it picked into <profile>/DevToolsActivePort (Edge prints nothing to stderr).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port = 0;
for (let i = 0; i < 160 && !port; i++) {
  try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]) || 0; } catch { /* not yet */ }
  if (!port) await sleep(125);
}
if (!port) await fail('the browser did not start');

let targets = [];
for (let i = 0; i < 40 && !targets.length; i++) {
  try { targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page'); } catch { /* not yet */ }
  if (!targets.length) await sleep(250);
}
if (!targets.length) await fail('no browser page');

const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
try {
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('devtools socket')), { once: true }); });
} catch (e) { await fail(e.message); }
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.id !== undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
});
ws.addEventListener('close', () => { for (const p of pending.values()) p.rej(new Error('browser closed')); pending.clear(); });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
closer = () => send('Browser.close');
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || ''));
  return r.result.value;
};

try {
  const design = vertical ? { w: 1080, h: 1920 } : { w: 1920, h: 1080 };
  const W = Math.max(2, Math.round((design.w * scale) / 2) * 2);
  const H = Math.max(2, Math.round((design.h * scale) / 2) * 2);
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const url = pathToFileURL(path.resolve(args.stage)).href + (vertical ? '#render-vertical' : '#render');
  await send('Page.navigate', { url });
  for (let i = 0; i < 80; i++) { if (await evalJs('window.__ready === true')) break; await sleep(100); if (i === 79) throw new Error('the stage did not load'); }
  await evalJs('document.fonts ? document.fonts.ready.then(() => true) : true');
  const duration = await evalJs('window.__duration');
  const total = Math.max(1, Math.ceil(duration * fps));

  const out = path.resolve(args.out);
  const part = out + '.part';
  ffmpeg = spawn(args.ffmpeg, [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-f', 'mp4', part,
  ], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let ffErr = '';
  ffmpeg.stderr.on('data', (d) => { ffErr += String(d); });
  const ffDone = new Promise((res) => ffmpeg.on('exit', (code) => res(code)));
  ffmpeg.stdin.on('error', () => { /* reported by the exit code */ });

  for (let f = 0; f < total; f++) {
    await evalJs(`window.__seek(${(f / fps).toFixed(4)})`);
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
    if (!ffmpeg.stdin.write(Buffer.from(shot.data, 'base64'))) await new Promise((r) => ffmpeg.stdin.once('drain', r));
    if (f % 6 === 0 || f === total - 1) console.log(`P ${f + 1} ${total}`);
  }
  ffmpeg.stdin.end();
  const code = await ffDone;
  if (code !== 0) throw new Error('ffmpeg failed: ' + ffErr.slice(0, 200));
  fs.renameSync(part, out);
  console.log('DONE');
  await cleanup();
  process.exit(0);
} catch (e) {
  await fail(e.message || e);
}
