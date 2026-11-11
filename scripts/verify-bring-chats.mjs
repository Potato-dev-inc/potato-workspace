#!/usr/bin/env node
/**
 * Live check for "Bring All My Chats" (BC-22). Drives the running app over the Chrome DevTools Protocol
 * and asserts what the person sees. It types only into the app's own search and card, never into an agent pane,
 * and sends nothing anywhere.
 *
 *   node scripts/verify-bring-chats.mjs <shots-dir> [--cdp 9433] [--expect claude=2,codex=3,opencode=2]
 *                                       [--search "stripe webhook"] [--no-move]
 *
 * Start the app first, on its own profile, its own CDP port and the fixture home (SPEC-n32 sections 4a and 6):
 *   POTATO_WORKSPACE_PROFILE=bc-live POTATO_WORKSPACE_HISTORY_HOME=<folder from make-fixture-history-home.mjs>
 * Use a fresh profile: step 3 expects every chat to be new. Port 9333 (the founder's app) is refused.
 * --expect counts are per agent (keys match the agent's name, case-insensitive). The default is the fixture alone.
 * The live run adds two real chats, so pass the real counts there.
 *
 * Steps. Each one writes a screenshot into <shots-dir> and a line into <shots-dir>/result.json:
 *   1 agents  "Bring my chats" lists each agent with its chat count; the count equals --expect.
 *   2 recent  pick the first agent: at most 10 chats, each with a folder, a date and a message count.
 *   3 bring   the All chip -> "Bring all N chats"; the progress line is shown if seen, and the result says
 *             "Done. N chats are now in your chat list." with N = the agent's count (empty chats are left out, so
 *             the check is "at most N and at least 1"). Then the same for every other expected agent.
 *   4 again   "Bring more" and bring the same range again: the result says the chats were already there.
 *   5 search  Ctrl+Shift+F, then --search: a hit with the "Old chat" tag shows the text.
 *   6 open    that hit opens a read-only viewer (no composer) with the text; Escape closes it.
 * Exit 0 when every step passes. On the first failure it keeps fail.png and exits 1.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = 'usage: node scripts/verify-bring-chats.mjs <shots-dir> [--cdp 9433] [--expect claude=2,codex=3,opencode=2] [--search "stripe webhook"] [--no-move]';
const FORBIDDEN_PORTS = new Set([9333]);
const DEFAULT_EXPECT = 'claude=2,codex=3,opencode=2';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

class StepFailed extends Error {}

/** Reads the command line. Throws a plain message for a bad one. */
export function parseArgs(argv) {
  const opts = { shots: null, cdp: 9433, expect: DEFAULT_EXPECT, search: 'stripe webhook', move: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cdp') opts.cdp = Number(argv[++i]);
    else if (arg === '--expect') opts.expect = argv[++i] ?? '';
    else if (arg === '--search') opts.search = argv[++i] ?? '';
    else if (arg === '--no-move') opts.move = false;
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else if (opts.shots === null) opts.shots = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (!opts.shots) throw new Error('missing <shots-dir>');
  if (!Number.isInteger(opts.cdp) || opts.cdp < 1024 || opts.cdp > 65535) throw new Error('--cdp takes a port number');
  if (FORBIDDEN_PORTS.has(opts.cdp)) throw new Error(`port ${opts.cdp} is the founder's app; use the bc-live CDP port`);
  if (!opts.search.trim()) throw new Error('--search needs text');
  opts.expect = parseExpect(opts.expect);
  return opts;
}

/** "claude=2,codex=3" -> { claude: 2, codex: 3 }. */
export function parseExpect(text) {
  const counts = {};
  for (const part of text.split(',')) {
    const [key, value] = part.split('=');
    if (!key || !/^[a-z0-9_-]+$/i.test(key.trim()) || !/^\d+$/.test(value ?? '')) {
      throw new Error(`--expect takes key=N pairs, got "${part}"`);
    }
    counts[key.trim().toLowerCase()] = Number(value);
  }
  return counts;
}

/** The chat count in an agent line: "Claude Code · 2 chats · 3 KB" -> 2. */
export function chatsIn(line) {
  const m = /(\d[\d,]*) chats?\b/.exec(line);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/** "Bring all 12 chats" or "Bring all 12 chats from this range" -> 12, anything else -> null. */
export function bringAllIn(text) {
  const m = /^Bring all (\d[\d,]*) chats?(?: from this range)?$/.exec(text);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/** Connects to the app page on the CDP port (the cockpit page when there is one). */
async function connect(port) {
  let list;
  try {
    list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  } catch {
    throw new Error(`no app answers on CDP port ${port}; start it with the bc-live profile first`);
  }
  const page = list.find((t) => t.type === 'page' && t.url.includes('cockpit=1')) ?? list.find((t) => t.type === 'page');
  if (!page) throw new Error(`no app page on CDP port ${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((open, fail) => {
    ws.addEventListener('open', open, { once: true });
    ws.addEventListener('error', () => fail(new Error('CDP socket failed')), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message));
    else waiter.resolve(msg.result);
  });
  const send = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = ++nextId;
      pending.set(id, { resolve: done, reject: fail });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('a page script failed');
    return r.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

/** Runs the whole check. Returns the process exit code. */
async function run(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`verify-bring-chats: ${err.message}\n${USAGE}`);
    return 2;
  }
  const shotsDir = resolve(opts.shots);
  mkdirSync(shotsDir, { recursive: true });
  let cdp;
  try {
    cdp = await connect(opts.cdp);
  } catch (err) {
    console.error(`verify-bring-chats: ${err.message}`);
    return 1;
  }

  const steps = [];
  let shots = 0;
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = `${String(++shots).padStart(2, '0')}-${name}.png`;
    writeFileSync(join(shotsDir, file), Buffer.from(r.data, 'base64'));
    return file;
  };
  const check = async (name, ok, detail = '', shotName = null) => {
    const shotFile = shotName ? await shot(shotName) : null;
    steps.push({ name, ok: Boolean(ok), detail, shot: shotFile });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
    if (!ok) throw new StepFailed(`${name}${detail ? `: ${detail}` : ''}`);
  };
  const waitFor = async (expression, what, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await cdp.evaluate(expression);
      if (value) return value;
      if (Date.now() > end) throw new StepFailed(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}`);
      await sleep(250);
    }
  };
  const clickAt = async (expression, what) => {
    const at = await cdp.evaluate(
      `(() => { const el = ${expression}; if (!el) return null; el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
    );
    if (!at) throw new StepFailed(`nothing to click: ${what}`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0], y: at[1] });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at[0], y: at[1], button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at[0], y: at[1], button: 'left', clickCount: 1 });
  };
  const key = async (name, code, vk, modifiers = 0) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: vk, modifiers });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk, modifiers });
  };
  // The agent buttons of step 1: name text.
  const rows = () =>
    cdp.evaluate(`[...document.querySelectorAll('section.bc-panel .bc-agent-pick')].map((b) => ({ name: b.innerText.replace(/\\s+/g, ' ').trim(), off: b.disabled }))`);
  const buttonText = (test) =>
    cdp.evaluate(`[...document.querySelectorAll('section.bc-panel button')].map((b) => b.textContent.trim()).find((t) => ${test}) ?? ''`);
  const clickButton = (label) =>
    clickAt(`[...document.querySelectorAll('section.bc-panel button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`, label);
  const pickAgent = (agentKey) =>
    clickAt(`[...document.querySelectorAll('section.bc-panel .bc-agent-pick')].find((b) => new RegExp(${JSON.stringify(agentKey)}, 'i').test(b.innerText))`, `the ${agentKey} button`);
  const resultLine = () => cdp.evaluate(`[...document.querySelectorAll('section.bc-panel [role="status"]')].map((e) => e.innerText.trim()).join(' | ')`);

  try {
    // Moves the app window to the left monitor (SPEC-n32 section 6), so the check never shows on the primary screen.
    if (opts.move) {
      try {
        const w = await cdp.send('Browser.getWindowForTarget');
        await cdp.send('Browser.setWindowBounds', {
          windowId: w.windowId,
          bounds: { windowState: 'normal', left: -1852, top: 121, width: 1400, height: 900 },
        });
      } catch {
        // Not available on this build: the window stays where it is.
      }
    }

    // 1 agents
    await waitFor(`!!document.querySelector('section.bc-panel')`, 'the Bring my chats panel (BringChatsPanel)', 20000);
    await waitFor(`document.querySelectorAll('section.bc-panel .bc-agent-pick').length > 0`, 'the agent list');
    const found = await rows();
    const counts = Object.entries(opts.expect).map(([agentKey, want]) => {
      const row = found.find((r) => new RegExp(agentKey, 'i').test(r.name));
      return { agentKey, want, got: row ? chatsIn(row.name) : null };
    });
    const summary = counts.map((c) => `${c.agentKey} ${c.got ?? 'none'} (want ${c.want})`).join(', ');
    await check('agents: counts match --expect', counts.every((c) => c.got === c.want), summary, 'agents');

    // 2 recent chats of the first agent
    const [first, ...others] = Object.keys(opts.expect);
    await pickAgent(first);
    await waitFor(`document.querySelectorAll('section.bc-panel .bc-row').length > 0`, 'the chat list');
    const list = await cdp.evaluate(
      `[...document.querySelectorAll('section.bc-panel .bc-row')].map((r) => ({
        title: !!r.querySelector('.bc-row-title')?.innerText.trim(),
        sub: r.querySelector('.bc-row-sub')?.innerText ?? '' }))`,
    );
    await check(
      'recent: at most 10 chats, each with a title, a date and a message count',
      list.length >= 1 && list.length <= 10 && list.every((r) => r.title && /ago|just now|Unknown date/.test(r.sub) && /messages?/.test(r.sub)),
      `${list.length} rows`,
      'recent',
    );

    // 3 bring everything of each expected agent (the All chip)
    const bringAll = async (agentKey) => {
      await clickButton('All');
      await waitFor(`!!document.querySelector('section.bc-panel .bc-range button')`, 'the "Bring all" button');
      const label = await buttonText('t.startsWith("Bring all")');
      const n = bringAllIn(label);
      await clickButton(label);
      let sawBar = false;
      let line = '';
      const end = Date.now() + 600000;
      while (Date.now() < end && !/^Done\./.test(line)) {
        if (!sawBar && (await cdp.evaluate(`!!document.querySelector('section.bc-panel .bc-bar')`))) {
          sawBar = true;
          await shot(`bringing-${agentKey}`);
        }
        line = await resultLine();
        if (!/^Done\./.test(line)) await sleep(300);
      }
      return { n, line, sawBar };
    };
    const firstRun = await bringAll(first);
    const doneCount = /^Done\. (\d[\d,]*) chats?/.exec(firstRun.line);
    const brought = doneCount ? Number(doneCount[1].replace(/,/g, '')) : null;
    await check(
      `bring: "Done. N chats are now in your chat list" for ${first}`,
      brought !== null && brought >= 1 && brought <= firstRun.n,
      `${firstRun.line.slice(0, 140) || 'no result line'}; offered ${firstRun.n}; progress bar seen: ${firstRun.sawBar}`,
      'done',
    );

    // 4 the same range again brings nothing new
    await clickButton('Bring more');
    await waitFor(`!!document.querySelector('section.bc-panel .bc-range button')`, 'the Bring all button again');
    const again = await bringAll(first);
    await check('again: the second run says the chats were already there', /already in your chat list/.test(again.line) || /Nothing new/.test(again.line), again.line.slice(0, 140), 'again');

    // The other agents, once each.
    for (const agentKey of others) {
      await clickButton('Bring more');
      await clickButton('‹ All agents');
      await pickAgent(agentKey);
      await waitFor(`document.querySelectorAll('section.bc-panel .bc-row').length > 0`, `the ${agentKey} chat list`);
      const run = await bringAll(agentKey);
      await check(`bring: ${agentKey} finishes`, /^Done\./.test(run.line), run.line.slice(0, 140));
    }

    // 5 search
    await key('F', 'KeyF', 70, 10); // Ctrl+Shift+F
    await waitFor(`!!document.querySelector('.ck-palette-input')`, 'the search box (Ctrl+Shift+F)');
    await clickAt(`document.querySelector('.ck-palette-input')`, 'search box');
    await cdp.send('Input.insertText', { text: opts.search });
    const query = opts.search.toLowerCase();
    await waitFor(
      `[...document.querySelectorAll('[role="option"]')].some((o) => o.innerText.includes('Old chat'))`,
      `an "Old chat" hit for "${opts.search}"`,
      30000,
    );
    const hitShows = await cdp.evaluate(
      `(() => { const list = document.querySelector('.ck-palette-list');
        return { text: list ? list.innerText.toLowerCase() : '',
          tagged: [...document.querySelectorAll('[role="option"]')].some((o) => o.innerText.includes('Old chat')) }; })()`,
    );
    await check(
      'search: an "Old chat" hit shows the text',
      hitShows.tagged && hitShows.text.includes(query),
      `"${opts.search}" ${hitShows.text.includes(query) ? 'found' : 'not in the list'}`,
      'search',
    );

    // 6 open the hit
    const hitOption = `((list) => list.find((o) => o.innerText.includes('Old chat') && o.innerText.toLowerCase().includes(${JSON.stringify(query)})) ?? list.find((o) => o.innerText.includes('Old chat')) ?? null)([...document.querySelectorAll('[role="option"]')])`;
    await clickAt(hitOption, 'the Old chat hit');
    await waitFor(`!!document.querySelector('.history-viewer')`, 'the read-only viewer');
    // The sheet fades in and loads the chat: wait for the banner and the text, so the read below is not a race.
    await waitFor(
      `(() => { const v = document.querySelector('.history-viewer'); return !!v && /read-only/i.test(v.querySelector('.history-viewer-banner')?.innerText ?? '') && v.innerText.toLowerCase().includes(${JSON.stringify(query)}); })()`,
      'the viewer to show the banner and the text',
      15000,
    );
    const viewer = await cdp.evaluate(
      `(() => { const v = document.querySelector('.history-viewer'); if (!v) return null; return {
        banner: v.querySelector('.history-viewer-banner')?.innerText ?? '',
        composer: !!v.querySelector('textarea, [contenteditable="true"]'),
        hasText: v.innerText.toLowerCase().includes(${JSON.stringify(query)}) }; })()`,
    );
    await check('open: read-only viewer with no composer shows the text', viewer && /read-only/i.test(viewer.banner) && !viewer.composer && viewer.hasText, viewer ? viewer.banner.slice(0, 120) : 'no viewer', 'viewer');
    await key('Escape', 'Escape', 27);
    await waitFor(`!document.querySelector('.history-viewer')`, 'the viewer to close');
    console.log(`All steps passed (${steps.length}).`);
  } catch (err) {
    const message = err instanceof StepFailed ? err.message : `unexpected error: ${err.message}`;
    console.error(`FAIL ${message}`);
    steps.push({ name: 'run', ok: false, detail: message });
    try {
      await shot('fail');
    } catch {
      // The screenshot is best effort.
    }
  } finally {
    cdp.close();
  }

  const ok = steps.every((s) => s.ok);
  writeFileSync(
    join(shotsDir, 'result.json'),
    JSON.stringify({ at: new Date().toISOString(), cdpPort: opts.cdp, expect: opts.expect, ok, steps }, null, 2),
  );
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}
