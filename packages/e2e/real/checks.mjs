// The screen checks of the real-app check. Each one runs in the real page of the real app and returns plain findings.
//   clickable  every visible control is what a click on it reaches (elementFromPoint, 5 points), nothing invisible on top
//   scrolls    every scroll area scrolls under a real mouse wheel; nothing the person needs sits below the fold unreachable
//   leaks      no internal name, raw error or raw path in visible text, title, aria-label or placeholder
// A finding is { check, screen, what, detail }. Deterministic: no retry; the page is only waited on to settle first.
import fs from 'node:fs';
import { sleep } from '../src/cdp.mjs';

const DENY = JSON.parse(fs.readFileSync(new URL('./denylist.json', import.meta.url), 'utf8'));

export async function settle(conn, maxMs = 3000) {
  // two animation frames with no DOM change in a row, or maxMs
  await conn.evalJs(`new Promise((res) => { let last = document.body.innerHTML.length, quiet = 0; const t0 = performance.now();
    const tick = () => { const n = document.body.innerHTML.length; quiet = n === last ? quiet + 1 : 0; last = n; if (quiet >= 4 || performance.now() - t0 > ${maxMs}) res(true); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); })`).catch(() => {});
}

const CLIP_HELPERS = `
  const vw = innerWidth, vh = innerHeight;
  const vis = (e) => { const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0; };
  const clipOf = (el) => {
    const r = el.getBoundingClientRect();
    let l = r.left, t = r.top, rt = r.right, b = r.bottom;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(hidden|auto|scroll|clip)/.test(cs.overflowX + ' ' + cs.overflowY)) { const pr = p.getBoundingClientRect(); l = Math.max(l, pr.left); t = Math.max(t, pr.top); rt = Math.min(rt, pr.right); b = Math.min(b, pr.bottom); }
    }
    return { l: Math.max(l, 0), t: Math.max(t, 0), r: Math.min(rt, vw), b: Math.min(b, vh), full: r };
  };
  const desc = (e) => e ? (e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).slice(0, 3).join('.') : '') + (e.getAttribute && e.getAttribute('aria-label') ? '[' + e.getAttribute('aria-label').slice(0, 30) + ']' : '')) : 'nothing';
`;

const SEL = 'button,a[href],[role=button],[role=tab],[role=menuitem],[role=menuitemradio],[role=switch],[role=checkbox],[role=radio],[role=option],input:not([type=hidden]),select,textarea,summary';

/** Check 1. */
export async function clickable(conn, screen) {
  const out = await conn.evalJs(`(() => { ${CLIP_HELPERS}
    const result = { tested: 0, skipped: 0, bad: [] };
    const scrollState = [...document.querySelectorAll('*')].filter((e) => e.scrollTop || e.scrollLeft).map((e) => [e, e.scrollTop, e.scrollLeft]);
    const SELSTR = ${JSON.stringify(SEL)};
    const els = [...document.querySelectorAll(SELSTR)];
    for (const el of els) {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[inert],[aria-hidden=true]')) { result.skipped++; continue; }
      if (!vis(el) || getComputedStyle(el).pointerEvents === 'none') { result.skipped++; continue; }
      let c = clipOf(el);
      if (c.full.width < 2 || c.full.height < 2) { result.skipped++; continue; }
      if (c.full.top < 0 || c.full.bottom > vh || c.full.left < 0 || c.full.right > vw) { el.scrollIntoView({ block: 'center', inline: 'nearest' }); c = clipOf(el); }
      const w = c.r - c.l, h = c.b - c.t;
      if (w < 4 || h < 4) { result.skipped++; continue; }
      const pts = [[0.5, 0.5], [0.2, 0.25], [0.8, 0.25], [0.2, 0.75], [0.8, 0.75]].map(([fx, fy]) => [c.l + w * fx, c.t + h * fy]);
      result.tested++;
      for (const [x, y] of pts) {
        const hit = document.elementFromPoint(x, y);
        const inner = hit && hit.closest ? hit.closest(SELSTR) : null;
        const nested = inner && inner !== el && !inner.contains(el) && el.contains(inner) === false && (() => { const a = inner.getBoundingClientRect(), b = el.getBoundingClientRect(); return a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1; })();
        const ok = hit && (nested || hit === el || el.contains(hit) || (hit.closest && hit.closest('label') && hit.closest('label').control === el) || (el.closest('label') && el.closest('label').contains(hit)));
        if (!ok) { result.bad.push({ el: desc(el), text: (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 40), at: [Math.round(x), Math.round(y)], cover: desc(hit), coverRect: hit ? (({ x, y, width, height }) => [Math.round(x), Math.round(y), Math.round(width), Math.round(height)])(hit.getBoundingClientRect()) : null }); break; }
      }
    }
    for (const [e, t, l] of scrollState) { e.scrollTop = t; e.scrollLeft = l; }
    return result;
  })()`);
  return {
    tested: out.tested, skipped: out.skipped,
    findings: out.bad.map((b) => ({ check: 'clickable', screen, what: `${b.el} "${b.text}" is covered by ${b.cover}`, detail: `point ${b.at.join(',')}; cover rect ${b.coverRect ? b.coverRect.join(',') : '-'}` })),
  };
}

/** Check 2. */
export async function scrolls(conn, screen) {
  const info = await conn.evalJs(`(() => { ${CLIP_HELPERS}
    window.__rtScrollers = [];
    const list = [];
    for (const e of document.querySelectorAll('*')) {
      const cs = getComputedStyle(e);
      if (!/(auto|scroll)/.test(cs.overflowY) || e.scrollHeight <= e.clientHeight + 2 || e.clientHeight < 60 || !vis(e) || e.closest('.xterm')) continue;
      const c = clipOf(e);
      if (c.b - c.t < 40 || c.r - c.l < 40) continue;
      window.__rtScrollers.push(e);
      list.push({ i: window.__rtScrollers.length - 1, d: desc(e), x: Math.round((c.l + c.r) / 2), y: Math.round((c.t + c.b) / 2), top: e.scrollTop, max: e.scrollHeight - e.clientHeight });
    }
    // controls below the fold with nothing that scrolls them into view
    const docScrolls = document.scrollingElement.scrollHeight > vh + 2 && !/hidden/.test(getComputedStyle(document.body).overflowY + getComputedStyle(document.documentElement).overflowY);
    const stuck = [];
    for (const el of document.querySelectorAll(${JSON.stringify(SEL)})) {
      if (el.disabled || !vis(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || (r.bottom <= vh + 1 && r.top >= -1)) continue;
      let p = el.parentElement, scrollable = false;
      while (p) { const cs = getComputedStyle(p); if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 2) { scrollable = true; break; } p = p.parentElement; }
      if (!scrollable && !docScrolls && getComputedStyle(el).position !== 'fixed') stuck.push({ d: desc(el), text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40), y: Math.round(r.top) });
    }
    return { list, stuck };
  })()`);
  const findings = [];
  for (const s of info.list) {
    if (s.top >= s.max - 1) continue; // already at the end: nothing to move
    await conn.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: s.x, y: s.y, deltaX: 0, deltaY: 240 });
    await sleep(200);
    const now = await conn.evalJs(`window.__rtScrollers[${s.i}].scrollTop`);
    if (!(now > s.top)) findings.push({ check: 'scrolls', screen, what: `${s.d} has more content but the mouse wheel does not move it`, detail: `scrollTop ${s.top} -> ${now}, max ${s.max}` });
    await conn.evalJs(`window.__rtScrollers[${s.i}].scrollTop = ${s.top}`);
  }
  for (const k of info.stuck) findings.push({ check: 'scrolls', screen, what: `${k.d} "${k.text}" is below the fold and nothing scrolls it into view`, detail: `top ${k.y}` });
  await conn.evalJs('delete window.__rtScrollers');
  return { scrollAreas: info.list.length, findings };
}

/** Check 4 (deny-list). */
export async function leaks(conn, screen, { skipSelector = '.xterm, .xterm-screen, [data-rt-skip]' } = {}) {
  const texts = await conn.evalJs(`(() => {
    const skip = ${JSON.stringify(skipSelector)};
    const out = [];
    const vis = (e) => { const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0 && r.width > 0 && r.height > 0; };
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const n = w.currentNode; const t = n.nodeValue.replace(/\\s+/g, ' ').trim();
      if (!t) continue;
      const p = n.parentElement; if (!p || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(p.tagName) || p.closest(skip) || !vis(p)) continue;
      out.push({ t, where: p.tagName.toLowerCase() + (p.className && typeof p.className === 'string' ? '.' + p.className.trim().split(/\\s+/)[0] : '') });
    }
    for (const e of document.querySelectorAll('[title],[aria-label],[placeholder]')) {
      if (e.closest(skip) || !vis(e)) continue;
      for (const a of ['title', 'aria-label', 'placeholder']) { const v = e.getAttribute(a); if (v && v.trim()) out.push({ t: v.trim(), where: e.tagName.toLowerCase() + '@' + a }); }
    }
    return out;
  })()`);
  const rules = DENY.rules.map((r) => ({ ...r, rx: new RegExp(r.re, r.flags) }));
  const seen = new Set();
  const findings = [];
  for (const { t, where } of texts) {
    if (DENY.allow.includes(t)) continue;
    for (const r of rules) {
      const m = r.rx.exec(t);
      if (!m) continue;
      const key = r.id + '|' + t.slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      const i = Math.max(0, m.index - 30);
      findings.push({ check: 'leaks', screen, what: `rule ${r.id} matched "${m[0]}" in ${where}`, detail: '…' + t.slice(i, i + 90) + '…' });
    }
  }
  return { scanned: texts.length, findings };
}

/** The harness proves it can see faults: injects an invisible cover, a scroll area that ignores the wheel and a leaky text, then asserts each check reports it. */
export async function selfTest(conn) {
  await conn.evalJs(`(() => {
    const d = document.createElement('div'); d.id = '__rt_cover'; d.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483000;background:transparent'; document.body.appendChild(d);
    const s = document.createElement('div'); s.id = '__rt_scroll'; s.style.cssText = 'position:fixed;left:300px;top:300px;width:200px;height:100px;overflow:auto;z-index:2147483001;background:#fff'; s.innerHTML = '<div style="height:600px">x</div>'; s.addEventListener('wheel', (e) => e.preventDefault(), { passive: false }); document.body.appendChild(s);
    const t = document.createElement('p'); t.id = '__rt_leak'; t.textContent = 'Error: EISDIR for pane_id [object Object]'; t.style.cssText = 'position:fixed;left:10px;top:10px;z-index:2147483002'; document.body.appendChild(t);
  })()`);
  const c1 = await clickable(conn, 'selftest'); const c2 = await scrolls(conn, 'selftest'); const c3 = await leaks(conn, 'selftest');
  await conn.evalJs(`['__rt_cover', '__rt_scroll', '__rt_leak'].forEach((id) => document.getElementById(id)?.remove())`);
  const ok = c1.findings.length > 0 && c2.findings.some((f) => /does not move/.test(f.what)) && c3.findings.length >= 3;
  return { ok, detail: `cover: ${c1.findings.length} finding(s), stuck scroll: ${c2.findings.filter((f) => /does not move/.test(f.what)).length}, leaks: ${c3.findings.length}` };
}
