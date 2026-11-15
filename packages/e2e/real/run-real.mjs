#!/usr/bin/env node
// The real-app check (P1): the release exe from an extracted copy of the newest MSI, its own profile, off the primary screen,
// real agents, real WebView. One command, one report.
//
//   node packages/e2e/real/run-real.mjs [--msi <file.msi>] [--exe <already extracted exe>] [--keep] [--skip-agents] [--run-id <id>]
//
// Safety (read PLAN-REAL-APP-TEST.md, Decisions + Lead override): never elevates, never installs, never opens the founder's app
// folder or data folder for writing, copies no login file (the app sees a throwaway HOME, the agent programs find their own
// sign-in through USERPROFILE), stops only the PIDs it started, no window on the primary screen, caps on the real-agent flows.
import fs from 'node:fs';
import path from 'node:path';
import { startWithCockpit, primaryScreen } from '../src/launcher.mjs';
import { sleep } from '../src/cdp.mjs';
import { extractMsi, findExes, sha256File } from './install.mjs';
import { snapshot, compare } from './founder-guard.mjs';
import { clickText, screenshot, watchConsole } from './cdp-util.mjs';
import { clickable, scrolls, leaks, settle, selfTest } from './checks.mjs';
import { staticScreens, chatScreens, setTheme } from './screens.mjs';
import { a0 } from './flows/a0-mcp-exe.mjs';
import { a1, A1_CAPS, HELPER_MODEL, ORCHESTRATOR_MODEL } from './flows/a1-standby.mjs';
import { writeReport } from './report.mjs';
import { trash, cpuLoad, countImages, processesMentioning, descendants, osInfo, versionOf, pidAlive, windowRects, secondaryAnchor } from './util.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const RELEASE_DIR = process.env.E2E_RELEASE_DIR || 'D:\\pm-night\\workspace-release';
const RESULTS = process.env.E2E_REALTEST_RESULTS || 'D:\\pm-night\\evidence-1116\\realtest';
const EXTRACT_BASE = process.env.E2E_REALTEST_EXTRACT || 'D:\\pm-realtest';

const runId = opt('--run-id') || `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(16).slice(2, 6)}`;
const dir = path.join(RESULTS, `run-${runId}`);
fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
const logLines = [];
const log = (s) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${s}`; logLines.push(l); console.log(l); };

function newestMsi() {
  const outs = fs.readdirSync(RELEASE_DIR).filter((d) => /^out-\d+\.\d+\.\d+$/.test(d))
    .sort((a, b) => a.slice(4).split('.').map(Number).reduce((x, y, i) => x || (y - b.slice(4).split('.').map(Number)[i]), 0)).reverse();
  for (const o of outs) { const f = fs.readdirSync(path.join(RELEASE_DIR, o)).find((x) => x.endsWith('.msi')); if (f) return path.join(RELEASE_DIR, o, f); }
  throw new Error('no MSI under ' + RELEASE_DIR);
}

const rows = []; const findings = []; const flows = []; const cleanupLines = []; const guardLines = [];
const consoleSink = [];
const header = [];
let app = null, conn = null, extractRoot = null, exe = opt('--exe');
let verdictHard = false;
const profileDirs = ['Roaming', 'Local'].map((k) => path.join(process.env.USERPROFILE || '', 'AppData', k, 'com.potatodev.workspace.profile-realtest'));

try {
  // ---- before: the founder's files
  const before = snapshot();
  fs.writeFileSync(path.join(dir, 'founder-before.json'), JSON.stringify(before, null, 1));
  log(`founder snapshot taken (install dir ${before.installDir.count} files; founder app running: ${before.founderAppRunning})`);

  // ---- the quiet-PC rule
  let load = cpuLoad(); let loaded = false;
  for (let i = 0; i < 4 && ((load ?? 0) > 60 || countImages(['cargo.exe', 'rustc.exe'])['cargo.exe'] > 0); i++) { log(`PC busy (cpu ${load}%), waiting`); await sleep(5000); load = cpuLoad(); }
  if ((load ?? 0) > 60) loaded = true;
  header.push(['PC load at start', `${load}% cpu${loaded ? ' (LOADED: no timing number counts)' : ''}`]);

  // ---- extract
  const msi = opt('--msi') || newestMsi();
  if (!exe) {
    const target = path.join(EXTRACT_BASE, 'Program Files', `PM RealTest ${runId}`, 'Potato Workspace');
    log(`extracting ${msi}`);
    const r = await extractMsi(msi, target);
    extractRoot = r.target;
    exe = findExes(extractRoot).app;
    header.push(['MSI', `${msi}`], ['MSI sha256 (unchanged after read)', r.msiSha256], ['files extracted', r.files]);
  } else {
    extractRoot = path.resolve(path.dirname(exe), '..', '..');
    header.push(['MSI', 'not extracted by this run (--exe given)']);
  }
  header.push(['exe under test', exe], ['exe sha256', await sha256File(exe)], ['path has a space', /\s/.test(exe) ? 'yes' : 'NO']);
  const mcpExe = findExes(path.dirname(exe)).mcp;
  header.push(['mode', 'extracted copy of the MSI, no installer ran, no elevation']);

  // ---- launch
  // The release exe moves a window that is anchored far off screen (-32000) back onto the primary screen, so the window goes on the
  // second monitor. No second monitor: the run refuses to start (it never opens a window on the primary screen).
  const anchor = secondaryAnchor();
  if (!anchor) throw new Error('no second monitor found: refusing to open a window on the primary screen');
  header.push(['window anchor (second monitor)', anchor]);
  log('starting the app (own profile realtest, HOME split, second monitor)');
  const started = await startWithCockpit({ exe, realAgents: true, homeMode: 'split', profile: 'realtest', runId: `realtest-${runId}`, headless: true, anchor, settings: { onboarding_done: true, away_minutes: 0 } }, { tries: 3, runIdFor: (n) => `realtest-${runId}-${n}`, onLost: (n, e) => log(`start ${n} lost: ${e.message.slice(0, 120)}`) });
  app = started.app; conn = started.conn;
  await conn.send('Network.enable'); await conn.send('Log.enable');
  watchConsole(conn, consoleSink);
  const bv = await conn.send('Browser.getVersion').catch(() => ({}));
  const prim = primaryScreen();
  const rects = windowRects(descendants(app.pid));
  const hits = (r) => !!prim && r.x < prim[0] + prim[2] && r.x + r.w > prim[0] && r.y < prim[1] + prim[3] && r.y + r.h > prim[1];
  const bigRects = rects.filter((r) => r.w >= 200 && r.h >= 120);
  const onPrimary = bigRects.some(hits);
  const shown = bigRects.map((r) => r.x + ',' + r.y + ' ' + r.w + 'x' + r.h + (r.title ? ' "' + r.title.slice(0, 24) + '"' : '')).join('; ') || 'no visible window';
  header.push(['app pid (only this tree is stopped)', app.pid], ['bridge port / CDP port', app.bridgePort + ' / ' + app.cdpPort], ['visible windows of the app (screen coordinates)', shown], ['primary screen', prim ? prim.join(',') : 'unknown'], ['WebView2', bv.product || 'unknown'], ['OS', osInfo()],
    ['claude', versionOf('claude')], ['opencode', versionOf('opencode')], ['orchestrator model', ORCHESTRATOR_MODEL], ['helper model', HELPER_MODEL], ['caps (A1)', JSON.stringify(A1_CAPS)]);
  rows.push({ name: 'No window of the app on the primary screen', result: onPrimary ? 'FAIL' : 'PASS', evidence: shown });
  if (onPrimary) verdictHard = true;
  await sleep(1500);

  // ---- real agents
  const nonce = 'zebra' + Math.random().toString(16).slice(2, 7);
  header.push(['nonce', nonce]);
  if (!flag('--skip-agents')) {
    log('A0: the MCP program');
    const r0 = await a0({ app, extractRoot }); flows.push(r0); rows.push({ name: 'A0 MCP program works from the spaced path', result: r0.verdict, evidence: r0.checks.filter((c) => !c.ok).map((c) => c.name).join('; ') || `${r0.checks.length} checks` });
    log(`A0: ${r0.verdict}`);
    if (!flag('--only-a0')) {
    log('A1: orchestrator + standby (real agents, tiny prompts)');
    const r1 = await a1({ app, conn, outDir: dir, nonce, log });
    flows.push(r1); rows.push({ name: 'A1 Claude uses an OpenCode standby through run_agent', result: r1.verdict, evidence: r1.checks.filter((c) => !c.ok).map((c) => c.name).join('; ') || `${r1.checks.length} checks, ${r1.seconds}s, ${r1.toolCalls} tool calls` });
    log(`A1: ${r1.verdict}`);
    }
  }

  // ---- screen sweep: dark then light
  const totals = { clickable: { tested: 0 }, scrolls: { areas: 0 }, leaks: { scanned: 0 } };
  const screenNames = new Set();
  let chatList = null;
  for (const theme of ['dark', 'light']) {
    const got = await setTheme(conn, theme);
    log(`theme ${theme} (app says ${got})`);
    if (got !== theme) { rows.push({ name: `Theme ${theme} can be set from the More menu`, result: 'FAIL', evidence: `the app reports "${got}"` }); verdictHard = true; }
    if (!chatList) chatList = await chatScreens(conn);
    const screens = [...staticScreens(), ...chatList];
    for (const s of screens) {
      const mark = consoleSink.length;
      const ok = await s.go(conn);
      await settle(conn);
      if (!ok && s.chat) { log('  ' + s.id + ': the row is gone (helpers come and go), skipped'); continue; }
      if (!ok) { findings.push({ screen: s.id, theme, check: 'reach', what: 'the navigation control for this screen was not found on screen', detail: s.title }); continue; }
      screenNames.add(s.id);
      await screenshot(conn, path.join(dir, 'shots', `${s.id}-${theme}.png`));
      const c1 = await clickable(conn, s.id); const c2 = await scrolls(conn, s.id); const c3 = await leaks(conn, s.id, s.chat ? { skipSelector: '.xterm, code, pre, [class*="max-w-[85%]"]' } : undefined);
      totals.clickable.tested += c1.tested; totals.scrolls.areas += c2.scrollAreas; totals.leaks.scanned += c3.scanned;
      const mine = [...c1.findings, ...c2.findings, ...c3.findings];
      for (const f of mine) findings.push({ ...f, theme });
      for (const e of consoleSink.slice(mark)) findings.push({ screen: s.id, theme, check: 'console', what: `${e.kind}: ${e.text}`, detail: '' });
      log(`  ${theme} ${s.id}: ${c1.tested} controls, ${c2.scrollAreas} scroll areas, ${mine.length} finding(s)`);
    }
  }
  const by = (c) => findings.filter((f) => f.check === c);
  const rowFor = (name, c, extra) => rows.push({ name, result: by(c).length ? 'FAIL' : 'PASS', evidence: `${extra}; ${by(c).length} finding(s)` });
  rowFor('Clickable: every visible control is what a click reaches', 'clickable', `${totals.clickable.tested} controls across ${screenNames.size} screens x 2 themes`);
  rowFor('Scrolls: scroll areas move under the wheel, nothing stuck below the fold', 'scrolls', `${totals.scrolls.areas} scroll areas`);
  rowFor('Leaks: no internal names, raw errors or raw paths on screen', 'leaks', `${totals.leaks.scanned} text items scanned`);
  rowFor('Console: no errors or failed requests while visiting screens', 'console', `${consoleSink.length} console/network error events in total`);
  rowFor('Screens reachable by clicking the real navigation', 'reach', `${screenNames.size} screens`);
  const st = await selfTest(conn);
  rows.push({ name: 'Harness self-test: the checks catch injected faults (invisible cover, stuck scroll, leaky text)', result: st.ok ? 'PASS' : 'FAIL', evidence: st.detail });
  rows.push({ name: 'Light and dark themes', result: 'PASS', evidence: 'every screen visited in both; screenshots in shots/ (no contrast check yet, that is P4)' });
} catch (e) {
  log('RUN ERROR: ' + (e.stack || e));
  rows.push({ name: 'The run itself', result: 'FAIL', evidence: String(e.message || e).slice(0, 300) });
  verdictHard = true;
} finally {
  // ---- cleanup: only our own tree
  const pid = app?.pid;
  let tree = [];
  if (pid) { tree = descendants(pid); try { fs.copyFileSync(app.logFile, path.join(dir, 'app.log')); } catch { /* none */ } await app.stop().catch(() => {}); }
  await sleep(1500);
  if (pid) {
    const left = tree.filter((p) => pidAlive(p));
    cleanupLines.push(left.length ? `LEFTOVER processes from the app tree after stop: ${left.join(', ')} (reported, not killed)` : `app process tree (${tree.length} pids) is gone`);
  }
  const mention = processesMentioning([`realtest-${runId}`, `PM RealTest ${runId}`]);
  if (mention.length) cleanupLines.push(`processes still mentioning this run: ${mention.map((m) => `${m.name}#${m.pid}`).join(', ')} (reported, not killed)`);
  else cleanupLines.push('no process mentions this run folder or the extract folder');
  const runDirs = fs.existsSync(path.join(process.env.TEMP || '', 'pm-e2e')) ? fs.readdirSync(path.join(process.env.TEMP, 'pm-e2e')).filter((d) => d.startsWith(`realtest-${runId}`)) : [];
  for (const d of runDirs) { const t = trash(path.join(process.env.TEMP, 'pm-e2e', d), 'realtest-run'); cleanupLines.push(`temp run folder ${d} -> ${t ? 'moved to trash' : 'could not move'}`); }
  for (const p of profileDirs) { const t = trash(p, 'realtest-profile'); if (t) cleanupLines.push(`profile folder ${path.basename(p)} (${path.basename(path.dirname(p))}) -> moved to trash`); }
  if (extractRoot && !flag('--keep') && !opt('--exe')) { const t = trash(path.dirname(extractRoot), 'realtest-extract'); cleanupLines.push(`extracted copy -> ${t ? 'moved to trash' : 'could not move'}`); }
  else if (extractRoot) cleanupLines.push(`extracted copy kept at ${extractRoot}`);

  // ---- after: the founder's files
  const after = snapshot([`realtest-${runId}`, `PM RealTest ${runId}`, 'pm-realtest']);
  fs.writeFileSync(path.join(dir, 'founder-after.json'), JSON.stringify(after, null, 1));
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'founder-before.json'), 'utf8'));
  const cmp = compare(before, after);
  guardLines.push(cmp.ok ? 'PASS: the installed app folder (file count, size, newest time, exe hash) and every potato-workspace* MCP entry in the Claude, Codex and OpenCode configs are identical before and after.' : 'FAIL: ' + cmp.hard.join(' | '));
  for (const i of cmp.info) guardLines.push('info: ' + i);
  guardLines.push(`founder data folders: read only by the snapshot; the app under test used its own profile "realtest" with APPDATA and LOCALAPPDATA in the temp run folder.`);
  guardLines.push('the agent programs (claude, opencode) wrote their normal session logs into the real home, like any use of them; no login file was copied or changed by the harness.');
  rows.push({ name: 'Founder install, MCP entries untouched', result: cmp.ok ? 'PASS' : 'FAIL', evidence: cmp.ok ? 'identical before/after' : cmp.hard.join(' | ').slice(0, 200) });
  if (!cmp.ok) verdictHard = true;

  const fails = rows.filter((r) => r.result === 'FAIL');
  const run = {
    runId, verdict: verdictHard || fails.length ? 'FAIL' : 'PASS',
    summary: fails.length ? `${fails.length} check group(s) failed: ${fails.map((r) => r.name).join('; ')}` : 'every check in this slice passed (extract mode only)',
    header, rows, flows, findings, guardLines, cleanupLines, console: consoleSink.slice(0, 50),
    notCovered: [
      'An installed copy: shortcuts, registry, the URL handler, uninstall (needs an elevated run, founder in person).',
      'Check 3 (styled), check 6 (theme contrast), layout, the 390 px phone layout, popovers and sheets, the globe browser window, the second-instance remote chat (P2).',
      'Team tabs (no team exists in the clean profile), Connect page contents, setup flows A7 (P2).',
      'A2 permission questions, A3 long tasks, A4 crash reasons, A6 Codex, timings (P3, P4).',
      'The standby helper was added with the app\'s own command (what the Add helper form calls), the chat was started through the bridge and the prompt sent through the bridge outbox; the tool question was answered by a real click on Yes. The sidebar was sampled about once a second, not every 100 ms.',
    ],
  };
  writeReport(dir, run);
  fs.writeFileSync(path.join(dir, 'run.log'), logLines.join('\n'));
  // token-shaped strings must never reach the results
  const bad = [];
  for (const f of fs.readdirSync(dir)) { if (!/\.(md|json|log|jsonl)$/.test(f)) continue; const t = fs.readFileSync(path.join(dir, f), 'utf8'); if (/sk-[A-Za-z0-9_-]{24,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{30,}/.test(t)) bad.push(f); }
  if (bad.length) { console.error('TOKEN-SHAPED TEXT in: ' + bad.join(', ')); process.exitCode = 3; }
  console.log(`\nREPORT: ${path.join(dir, 'report.md')}\nVERDICT: ${run.verdict}`);
  if (run.verdict !== 'PASS') process.exitCode = process.exitCode || 1;
}
