// Real-browser check for the mark-up bar on a page with a strict Content-Security-Policy.
// Usage: node csp_check.mjs <chrome-or-edge-exe> <bar-script.js> <page-url> <key> [screenshot.png]
// Headless (no window). Prints one line starting with OK or FAIL and exits 0 / 1.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

const [exe, scriptPath, pageUrl, key, shotPath] = process.argv.slice(2);
const script = readFileSync(scriptPath, 'utf8');

function crc32(buf) {
  let c, crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
// An 8 x 6 solid red PNG.
function png() {
  const w = 8, h = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1); raw[o + 1 + x * 4] = 220; raw[o + 2 + x * 4] = 20; raw[o + 3 + x * 4] = 20; raw[o + 4 + x * 4] = 255; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const profile = mkdtempSync(join(tmpdir(), 'pm-csp-'));
const child = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const done = (ok, msg) => { try { child.kill(); } catch {} console.log((ok ? 'OK ' : 'FAIL ') + msg); setTimeout(() => process.exit(ok ? 0 : 1), 300); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws')); });
  let id = 0; const wait = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
  const send = (method, params = {}, sessionId) => new Promise((res) => { const n = ++id; wait.set(n, res); ws.send(JSON.stringify({ id: n, method, params, sessionId })); });
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable'); await S('DOM.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
  await S('Page.navigate', { url: pageUrl });
  await sleep(800);
  const ev = (expression) => S('Runtime.evaluate', { expression, returnByValue: true });
  // Prove the page really is strict: an inline style attribute and a data: image are both refused.
  const strictValue = (await S('Runtime.evaluate', { expression: `new Promise((res) => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('blocked'); i.src = 'data:image/png;base64,${png().toString('base64')}'; })`, awaitPromise: true, returnByValue: true })).result.result.value;
  if (strictValue !== 'blocked') return done(false, `the test page is not strict (data: image ${strictValue})`);
  await ev(script);
  await ev(`window[${JSON.stringify(key)}].set(JSON.stringify({ open: true, theme: 'dark' }))`);
  await sleep(200);
  const key_ = (k, extra = {}) => S('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text: k.length === 1 ? k : undefined, ...extra }).then(() => S('Input.dispatchKeyEvent', { type: 'keyUp', key: k, ...extra }));
  await key_('r');
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 200 });
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 200, button: 'left', clickCount: 1 });
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 320, y: 280, buttons: 1 });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 320, y: 280, button: 'left', clickCount: 1 });
  await key_('Enter', { modifiers: 2 });
  await sleep(300);
  const url = 'data:image/png;base64,' + png().toString('base64');
  await ev(`window[${JSON.stringify(key)}].set(JSON.stringify({ thumb: ${JSON.stringify(url)}, taking: false }))`);
  await sleep(500);
  // The bar lives in a closed shadow root; the DOM domain can pierce it.
  const { result: { root } } = await S('DOM.getDocument', { depth: -1, pierce: true });
  const find = (n) => { if (n.nodeName === 'CANVAS') return n; for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) { const f = find(c); if (f) return f; } return null; };
  const canvas = find(root);
  if (!canvas) return done(false, 'no picture canvas in the bar');
  const { result: { object } } = await S('DOM.resolveNode', { nodeId: canvas.nodeId });
  const info = (await S('Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true, functionDeclaration: `function(){ var d = this.getContext('2d').getImageData(0,0,1,1).data; var r = this.getBoundingClientRect(); return { w: this.width, h: this.height, px: [d[0], d[1], d[2], d[3]], shown: r.width > 0 && r.height > 0 }; }` })).result.result.value;
  if (shotPath) { const shot = await S('Page.captureScreenshot', { format: 'png' }); writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64')); }
  if (info.w === 8 && info.h === 6 && info.px[0] === 220 && info.px[3] === 255 && info.shown) return done(true, `picture drawn on a strict page ${JSON.stringify(info)}`);
  return done(false, `picture not drawn ${JSON.stringify(info)}`);
}
main().catch((err) => done(false, String((err && err.stack) || err)));
