// Small page helpers for the real-app check. Raw CDP only: no overlay, no injected cursor (the screen checks must see
// the page exactly as a person's browser does). Real mouse events, so a covering layer swallows the click like it would for a person.
import fs from 'node:fs';
import { sleep } from '../src/cdp.mjs';

export const q = (s) => JSON.stringify(s);

/** Runs inside the page: the visible interactive elements with their text and centre point. */
const LIST_JS = `(() => {
  const SEL = 'button,a[href],[role=button],[role=tab],[role=menuitem],[role=switch],[role=checkbox],[role=radio],[role=option],input,select,textarea,summary,[tabindex]:not([tabindex="-1"])';
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const out = [];
  document.querySelectorAll(SEL).forEach((e, i) => {
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const cs = getComputedStyle(e);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return;
    out.push({ i, tag: e.tagName.toLowerCase(), role: e.getAttribute('role') || '', text: norm(e.innerText || e.value || '').slice(0, 60), aria: e.getAttribute('aria-label') || '', title: e.getAttribute('title') || '', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), disabled: e.disabled === true || e.getAttribute('aria-disabled') === 'true' });
  });
  return out;
})()`;

export async function listInteractive(conn) { return conn.evalJs(LIST_JS); }

/** Page-space centre of the first visible element whose text / aria-label / title matches (string: equals, case-insensitive, or RegExp). */
export async function findByText(conn, match, { within } = {}) {
  const re = match instanceof RegExp ? { src: match.source, flags: match.flags } : { src: '^' + String(match).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', flags: 'i' };
  return conn.evalJs(`(() => {
    const re = new RegExp(${q(re.src)}, ${q(re.flags)});
    const root = ${within ? `document.querySelector(${q(within)})` : 'document'} || document;
    const SEL = 'button,a,[role=button],[role=tab],[role=menuitem],[role=option],[role=switch],[role=checkbox],input,select,summary,label,[tabindex]';
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0; };
    for (const e of root.querySelectorAll(SEL)) {
      if (!vis(e)) continue;
      const names = [norm(e.innerText), e.getAttribute('aria-label') || '', e.getAttribute('title') || ''];
      if (names.some((n) => n && re.test(n))) { e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: names[0].slice(0, 60) }; }
    }
    return null;
  })()`);
}

export async function mouseClick(conn, x, y) {
  await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

/** Click what a person would click: by visible text or label. Returns false when it is not on screen. */
export async function clickText(conn, match, opts) {
  const hit = await findByText(conn, match, opts);
  if (!hit) return false;
  await mouseClick(conn, hit.x, hit.y);
  await sleep(opts?.settle ?? 600);
  return true;
}

export async function waitForText(conn, re, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = await conn.evalJs('document.body ? document.body.innerText : ""').catch(() => '');
    if (re.test(t)) return true;
    await sleep(250);
  }
  return false;
}

export async function screenshot(conn, file) {
  const r = await conn.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(file.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}

/** Light or dark: the app's own setting (data-theme / class on the root) is flipped through its toggle when it is there, and the
 * browser's preference is emulated too, so a screen that follows either one re-renders. */
export async function setTheme(conn, mode) {
  await conn.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: mode }] });
  await conn.evalJs(`(() => { const r = document.documentElement; try { localStorage.setItem('theme', ${q(mode)}); } catch {} r.setAttribute('data-theme', ${q(mode)}); r.classList.toggle('dark', ${q(mode)} === 'dark'); r.classList.toggle('light', ${q(mode)} === 'light'); })()`);
  await sleep(500);
}

/** Collect console errors and failed requests into `sink` (an array) until the returned function is called. */
export function watchConsole(conn, sink) {
  const off = conn.on((m) => {
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      sink.push({ kind: 'console.error', text: (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300) });
    } else if (m.method === 'Runtime.exceptionThrown') {
      sink.push({ kind: 'exception', text: (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 300) });
    } else if (m.method === 'Network.loadingFailed' && !m.params.canceled) {
      sink.push({ kind: 'request.failed', text: `${m.params.errorText || ''} ${m.params.type || ''}`.trim() });
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      sink.push({ kind: 'log.error', text: `${m.params.entry.text || ''} ${m.params.entry.url || ''}`.slice(0, 300) });
    }
  });
  return off;
}
