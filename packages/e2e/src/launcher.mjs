// Starts ONE isolated copy of the real app for a run, and tears down only the process tree it started.
//
// Isolation (checked by guards.mjs and by the launcher itself):
//  - its own profile (POTATO_WORKSPACE_PROFILE=e2e): another app id, its own bridge port, never 17321/17322 (Puppet Master) or 17421/17422 (a default Potato Workspace)
//  - APPDATA, HOME and USERPROFILE point into a temp folder per run, so settings, agent definitions and chats are
//    fresh and nothing is read from or written to the real user folders
//  - a random free WebView2 debugging port (never 9333)
//  - fake agents only: copies of tools/pm-fake-tui under the names the agent definitions in fixtures/agents/ ask for
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { appExe, fakeTuiExe, tmpBase, AGENT_FIXTURES, REPO } from './paths.mjs';
import { assertSafePort, assertSafeProfile, isFoundersDataDir } from './guards.mjs';
import { connect, listTargets, sleep } from './cdp.mjs';
import { BridgeClient } from './bridge.mjs';

const DEFAULT_ANCHOR = '-1852,121'; // the secondary (left) monitor, where the dev app opens its windows
const OFFSCREEN_ANCHOR = '-32000,-32000';
// A busy PC (other builds running) can take over a minute to bring the web view up; waiting longer costs nothing when it is quick.
const COCKPIT_WAIT_MS = +process.env.E2E_COCKPIT_WAIT_MS || 90000;

const live = new Set();
let hooksInstalled = false;
function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const killAll = () => { for (const a of [...live]) a.killSync(); };
  process.on('exit', killAll);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => { killAll(); process.exit(130); });
  process.on('uncaughtException', (e) => { console.error(e); killAll(); process.exit(1); });
}

/** Bounds of the primary screen as [x, y, w, h], or null when it cannot be read (not Windows, no PowerShell). Cached. */
let primaryBounds;
export function primaryScreen() {
  if (primaryBounds !== undefined) return primaryBounds;
  primaryBounds = null;
  if (process.platform !== 'win32') return primaryBounds;
  try {
    const script = 'Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "$($b.X) $($b.Y) $($b.Width) $($b.Height)"';
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const n = (r.stdout || '').trim().split(/\s+/).map(Number);
    if (n.length === 4 && n.every(Number.isFinite)) primaryBounds = n;
  } catch { /* unknown */ }
  return primaryBounds;
}

/**
 * The window must never open on the primary screen. The app puts its first window at the anchor plus a small offset (40,60),
 * then cascades the next ones (28 px steps, 8 slots). An anchor that would land a window on the primary screen (the secondary
 * monitor is unplugged and the primary now covers it, or a wrong value was given) becomes the off-screen anchor. When the
 * primary screen cannot be read the anchor is used as given.
 */
export function safeAnchor(anchor) {
  const primary = primaryScreen();
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(anchor || '');
  if (!primary || !m) return anchor;
  const [px, py, pw, ph] = primary;
  const x = +m[1], y = +m[2];
  const inside = (cx, cy) => cx >= px && cx < px + pw && cy >= py && cy < py + ph;
  const reaches = [[40, 60], [40 + 7 * 28, 60 + 7 * 28]].some(([dx, dy]) => inside(x + dx, y + dy));
  if (!reaches) return anchor;
  console.error(`! window anchor ${anchor} would open on the primary screen; using ${OFFSCREEN_ANCHOR} instead`);
  return OFFSCREEN_ANCHOR;
}

export async function freePort() {
  for (let i = 0; i < 20; i++) {
    const port = await new Promise((res, rej) => {
      const s = net.createServer();
      s.once('error', rej);
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    });
    try { assertSafePort(port, 'random port'); return port; } catch { /* try another */ }
  }
  throw new Error('no free port');
}

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

/** Agent definitions to install: every *.toml in fixtures/agents, with the program names each one asks for. */
export function agentFixtures() {
  if (!exists(AGENT_FIXTURES)) return [];
  return fs.readdirSync(AGENT_FIXTURES).filter((f) => f.endsWith('.toml')).map((file) => {
    const text = fs.readFileSync(path.join(AGENT_FIXTURES, file), 'utf8');
    const id = (text.match(/^\s*id\s*=\s*"([^"]+)"/m) || [])[1] || file.replace(/\.toml$/, '');
    const names = ((text.match(/^\s*names\s*=\s*\[([^\]]*)\]/m) || [])[1] || '')
      .split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    return { file, id, names, text };
  });
}

export const DEFAULT_SCRIPT = `# The script every fake agent plays unless a test writes its own (t.fake.script).
agent = "nimbus"
boot_ms = 150
inline = true
`;

/**
 * `reuse`: start again on the data folder of an earlier start with the same `runId` (a restart inside a test): the saved
 * settings, the fake agent's script and log stay as they are.
 * @param {{ runId: string, profile?: string, anchor?: string, headless?: boolean, window?: [number, number], settings?: object, reuse?: boolean }} opts
 */
export async function startApp(opts) {
  installHooks();
  const exe = appExe();
  const fake = fakeTuiExe();
  if (!exists(exe)) throw new Error(`app binary not found: ${exe}\nRun: npm run e2e:build`);
  if (!exists(fake)) throw new Error(`fake agent not found: ${fake}\nRun: npm run e2e:build`);
  const profile = opts.profile || process.env.E2E_PROFILE || 'e2e';
  assertSafeProfile(profile);

  const root = path.join(tmpBase(), opts.runId);
  const dirs = {
    root,
    appdata: path.join(root, 'appdata'),
    home: path.join(root, 'home'),
    bin: path.join(root, 'bin'),
    projects: path.join(root, 'projects'),
    fake: path.join(root, 'fake'),
    local: path.join(root, 'local'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const appId = `com.potatodev.workspace.profile-${profile}`;
  const dataDir = path.join(dirs.appdata, appId);
  if (isFoundersDataDir(dataDir)) throw new Error('refusing: the data folder is the real app folder');
  fs.mkdirSync(path.join(dataDir, 'agents'), { recursive: true });

  // Agent definitions plus the fake programs they name.
  const fixtures = agentFixtures();
  for (const fx of fixtures) {
    fs.writeFileSync(path.join(dataDir, 'agents', fx.file), fx.text);
    for (const n of fx.names) fs.copyFileSync(fake, path.join(dirs.bin, process.platform === 'win32' ? `${n}.exe` : n));
  }
  const scriptPath = path.join(dirs.fake, 'script.toml');
  const fakeLog = path.join(dirs.fake, 'events.jsonl');
  if (!opts.reuse || !exists(scriptPath)) fs.writeFileSync(scriptPath, DEFAULT_SCRIPT);
  if (!opts.reuse || !exists(fakeLog)) fs.writeFileSync(fakeLog, '');

  // Settings the app starts with. The first-run welcome is switched off by default; a test that wants it
  // (or any other setting) passes `meta.seed` (a null value removes a key), which also restarts the app for it.
  const settings = { onboarding_done: true, away_minutes: 0, ...(opts.settings || {}) };
  for (const k of Object.keys(settings)) if (settings[k] === null) delete settings[k];
  // A restart in a test keeps what the person changed: the settings window saves through the store plugin, whose file is
  // under the home folder (Windows resolves the plugin's folder from USERPROFILE, the app's own settings reader from
  // APPDATA), so that file is the one to carry over.
  const storeFile = path.join(dirs.home, 'AppData', 'Roaming', appId, 'settings.json');
  if (opts.reuse && exists(storeFile)) fs.copyFileSync(storeFile, path.join(dataDir, 'settings.json'));
  else if (!opts.reuse || !exists(path.join(dataDir, 'settings.json'))) fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ settings }, null, 2));

  const cdpPort = await freePort();
  assertSafePort(cdpPort, 'debugging port');
  const headless = opts.headless || process.env.E2E_HEADLESS === '1';
  const anchor = safeAnchor(opts.anchor || process.env.PM_WINDOW_ANCHOR || (headless ? OFFSCREEN_ANCHOR : DEFAULT_ANCHOR));
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const env = {
    ...process.env,
    POTATO_WORKSPACE_PROFILE: profile,
    APPDATA: dirs.appdata,
    LOCALAPPDATA: dirs.local,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    XDG_DATA_HOME: dirs.local,
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'), // the browser profile (localStorage, cache) is per run too
    PM_WINDOW_ANCHOR: anchor,
    // A normal start now opens the cockpit by itself, but that window is created before the debugging port is
    // usable, so the harness never sees it. Start headless and let ensureCockpit open the window the supported way.
    POTATO_WORKSPACE_NO_WINDOW: process.env.E2E_STARTUP_WINDOW === '1' ? '0' : '1',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    PM_FAKE_TUI_SCRIPT: scriptPath,
    PM_E2E_PATH_PREPEND: dirs.bin,
    PM_FAKE_TUI_LOG: fakeLog,
    // The e2e build is a debug build, which shows every Labs switch on by default. The tests start from the
    // stored switches (Labs off), so the development override is switched off here.
    PM_DEV_LABS: '0',
    [pathKey]: dirs.bin + path.delimiter + (process.env[pathKey] || ''),
    RUST_LOG: process.env.RUST_LOG || 'info',
  };
  // Never read a bridge port/secret an earlier instance left in this folder: wait for the NEW ones.
  for (const f of ['potato-workspace.bridge.port', 'potato-workspace.bridge.secret']) { try { fs.rmSync(path.join(dataDir, f), { force: true }); } catch { /* none */ } }
  const logFile = path.join(root, 'app.log');
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(exe, [], { env, stdio: ['ignore', logFd, logFd], windowsHide: false, cwd: dirs.root });
  let exited = null;
  child.on('exit', (code, sig) => { exited = { code, sig }; });
  const app = {
    runId: opts.runId, profile, pid: child.pid, cdpPort, dirs, dataDir, scriptPath, fakeLog, logFile, anchor, exe, fixtures,
    bridgePort: 0, secret: '', bridge: null, window: opts.window || [1440, 900],
    get exited() { return exited; },
    alive: () => !exited,
    /** Leave the app running when this process exits (--keep-app). */
    detach() { live.delete(this); },
    killSync() {
      if (this._killed) return;
      this._killed = true;
      live.delete(this);
      killTree(child.pid);
    },
    async stop() {
      this.killSync();
      for (let i = 0; i < 40 && !exited; i++) await sleep(100); // wait until the process is really gone
      await sleep(300);
      try { fs.closeSync(logFd); } catch { /* closed */ }
    },
  };
  live.add(app);
  fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify({ appPid: child.pid, ownerPid: process.pid, exe }));

  try {
    // 1. the bridge port and secret files appear when the app is up
    const portFile = path.join(dataDir, 'potato-workspace.bridge.port');
    const secretFile = path.join(dataDir, 'potato-workspace.bridge.secret');
    await waitUntil(() => {
      if (exited) throw new Error(`the app exited at start (code ${exited.code}). See ${logFile}`);
      return exists(portFile) && exists(secretFile);
    }, 60000, 'the bridge port file');
    app.bridgePort = +((fs.readFileSync(portFile, 'utf8').match(/\d{4,5}/) || [0])[0]);
    assertSafePort(app.bridgePort, 'bridge port');
    app.secret = fs.readFileSync(secretFile, 'utf8').trim();
    app.bridge = new BridgeClient(app.bridgePort, app.secret);
    await waitUntil(async () => { try { return (await app.bridge.get('/health')).status === 200; } catch { return false; } }, 30000, 'the bridge /health');
    // 2. ask for the cockpit right away (see requestCockpit), then
    if (process.env.E2E_STARTUP_WINDOW !== '1') app.helperPane = await requestCockpit(app);
    // 3. approve the fake agents' definitions (the app asks for approval of every definition it did not write itself)
    await approveDefinitions(app);
  } catch (e) {
    await app.stop();
    throw e;
  }
  return app;
}

async function approveDefinitions(app) {
  if (process.env.E2E_SKIP_APPROVE) return;
  if (!app.fixtures.length) return;
  await app.bridge.post('/agents/definitions/reload', {});
  const list = (await app.bridge.get('/agents/definitions')).body || {};
  const entries = Array.isArray(list) ? list : list.agents || list.definitions || list.entries || [];
  for (const fx of app.fixtures) {
    const e = entries.find((x) => (x.id || x.agent?.id) === fx.id || String(x.file || '').endsWith(fx.file));
    if (!e) throw new Error(`agent definition ${fx.id} was not loaded: ${JSON.stringify(list).slice(0, 600)}`);
    if (e.approved === true || e.state === 'approved' || e.status === 'approved' || e.status === 'active') continue;
    const a = await app.bridge.post('/agents/definitions/approve', { file: e.file || fx.file, fingerprint: e.fingerprint || e.sha || e.hash });
    if (a.status !== 200) throw new Error(`approving ${fx.id} failed: ${a.status} ${JSON.stringify(a.body).slice(0, 400)}`);
  }
}

function pidAlive(pid, imageStart) {
  try {
    if (process.platform !== 'win32') { process.kill(pid, 0); return true; }
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const line = (r.stdout || '').split(String.fromCharCode(10)).find((l) => l.includes(`"${pid}"`));
    return !!line && (!imageStart || line.toLowerCase().startsWith(`"${imageStart.toLowerCase()}`));
  } catch { return false; }
}

/**
 * A run killed hard (the dashboard's process was killed, a crash) can leave its app running. Each run records
 * who started which app in <run folder>/app.json; this stops only an app recorded there whose starter is gone and
 * whose image is still puppet_master_app. Returns the pids it stopped.
 */
export function reapOrphans() {
  const stopped = [];
  let runs = [];
  try { runs = fs.readdirSync(tmpBase()); } catch { return stopped; }
  for (const name of runs) {
    const f = path.join(tmpBase(), name, 'app.json');
    let rec; try { rec = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (!rec.appPid || rec.reaped) continue;
    if (pidAlive(rec.ownerPid)) continue; // the run that started it is still going
    if (pidAlive(rec.appPid, 'puppet_master_app')) { killTree(rec.appPid); stopped.push(rec.appPid); }
    try { fs.writeFileSync(f, JSON.stringify({ ...rec, reaped: true })); } catch { /* read-only */ }
  }
  return stopped;
}

export function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
}

export async function waitUntil(fn, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { if (await fn()) return; } catch (e) { last = e; if (/exited at start/.test(e.message)) throw e; }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${last ? ': ' + last.message : ''}`);
}

/** The cockpit page target on the app's debugging port, or null. */
export async function findCockpit(app) {
  try { return (await listTargets(app.cdpPort)).find((t) => t.type === 'page' && /cockpit=1/.test(t.url)) || null; } catch { return null; }
}

/**
 * Ask the app for its cockpit window without taking focus: spawn a plain shell pane and ask the bridge to detach it, which
 * opens the cockpit unfocused at the window anchor. Returns the helper pane's id (closed once the cockpit is reached).
 *
 * This has to happen as early as possible. The app builds a hidden helper web view (the mode-switch overlay) about a second
 * after the bridge is up; if that web view is created before the cockpit, WebView2 starts its browser without ever opening
 * the debugging port and the cockpit can never be reached (a product quirk, found 2026-11-12). `startApp` therefore calls
 * this right after the bridge answers, before anything else; `ensureCockpit` only waits.
 */
async function requestCockpit(app) {
  const sp = await app.bridge.post('/panes', { agent_type: 'powershell', cwd: app.dirs.projects, cols: 100, rows: 30 });
  if (sp.status >= 300) throw new Error(`could not open the cockpit (spawn): ${sp.status} ${JSON.stringify(sp.body).slice(0, 300)}`);
  const id = sp.body?.snapshot?.pane_id || sp.body?.pane_id;
  await app.bridge.post(`/panes/${encodeURIComponent(id)}/detach`, {});
  return id;
}

/** How long a debugging port may stay closed after the cockpit was asked for before the start counts as lost (see above). */
const PORT_DEAD_MS = +process.env.E2E_PORT_DEAD_MS || 20000;

/**
 * Make sure a cockpit window exists and return a CDP connection to it. If the app already opened one (E2E_STARTUP_WINDOW=1)
 * use it; otherwise wait for the one `startApp` asked for. A start that lost the race described at `requestCockpit` (the port
 * never opens) fails after PORT_DEAD_MS, so the runner can start the app again instead of waiting for nothing.
 */
export async function ensureCockpit(app) {
  let t = null;
  if (process.env.E2E_STARTUP_WINDOW === '1') {
    for (let i = 0; i < 16 && !t; i++) { t = await findCockpit(app); if (!t) await sleep(250); }
  }
  if (!t) {
    const helper = app.helperPane || (await requestCockpit(app));
    const asked = Date.now();
    let portSeen = false;
    try {
      await waitUntil(async () => {
        try { const all = await listTargets(app.cdpPort); portSeen = true; t = all.find((x) => x.type === 'page' && /cockpit=1/.test(x.url)) || null; return !!t; } catch {
          if (!portSeen && Date.now() - asked > PORT_DEAD_MS) throw new Error('exited at start: the debugging port never opened');
          return false;
        }
      }, COCKPIT_WAIT_MS, 'the cockpit window');
    } catch (e) {
      let seen = 'none'; try { seen = JSON.stringify((await listTargets(app.cdpPort)).map((x) => `${x.type} ${String(x.url).slice(0, 70)}`)); } catch (err) { seen = 'unreadable: ' + err.message; }
      throw new Error(`timed out waiting for the cockpit window: ${e.message} (debugging port ${app.cdpPort} lists: ${seen})`);
    }
    await sleep(1000);
    await app.bridge.del(`/panes/${encodeURIComponent(helper)}`);
  }
  const c = await connect(t.webSocketDebuggerUrl);
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  return c;
}

/**
 * Start the app and reach its cockpit. A start that loses the race described at `requestCockpit` is stopped and tried again
 * (the app is cheap to start: about 6 s); `runIdFor(n)` names the data folder of try n, `onLost` is told about each lost try.
 * @returns {Promise<{ app: object, conn: object }>}
 */
export async function startWithCockpit(startOpts, { tries = 4, runIdFor = (n) => startOpts.runId, onLost = () => {} } = {}) {
  let lastError;
  for (let n = 1; n <= tries; n++) {
    let app = null;
    try {
      app = await startApp({ ...startOpts, runId: runIdFor(n) });
      const conn = await ensureCockpit(app);
      return { app, conn };
    } catch (e) {
      lastError = e;
      if (app) await app.stop().catch(() => {});
      onLost(n, e);
    }
  }
  throw lastError;
}
