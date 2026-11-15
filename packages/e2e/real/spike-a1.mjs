// Prototype of flow A1 to learn the real shapes (standby view, chat state, model options). Tiny prompts only.
import fs from 'node:fs';
import path from 'node:path';
import { startApp, ensureCockpit } from '../src/launcher.mjs';
import { sleep } from '../src/cdp.mjs';
import { listInteractive, clickText, screenshot } from './cdp-util.mjs';

const [exe, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const app = await startApp({ exe, realAgents: true, homeMode: 'split', profile: 'realtest', runId: 'realtest-a1-' + Math.random().toString(16).slice(2, 6), headless: true });
const res = { steps: [] };
const log = (k, v) => { res.steps.push({ k, v: typeof v === 'string' ? v.slice(0, 2500) : JSON.stringify(v).slice(0, 2500) }); };
const inv = async (conn, cmd, args) => (await conn.send('Runtime.evaluate', { expression: `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args || {})}).then(v => JSON.stringify(v), e => JSON.stringify({ __err: String(e) }))`, awaitPromise: true, returnByValue: true })).result.value;
try {
  const conn = await ensureCockpit(app);
  const proj = path.join(app.dirs.projects, 'p1'); fs.mkdirSync(proj, { recursive: true });
  log('addon', await inv(conn, 'acp_addon_install', { agentId: 'claude' }));
  for (let i = 0; i < 60; i++) { await sleep(2000); const s = JSON.parse(await inv(conn, 'acp_addon_status')); const c = (s.addons || []).find((x) => x.agent === 'claude'); if (c && c.state !== 'installing') { log('addon-final', c.state); break; } }
  log('helper-add', await inv(conn, 'standby_helper_add', { input: { name: 'RT helper', agent: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', project: proj, after_task: 'wait' } }));
  for (let i = 0; i < 30; i++) { await sleep(2000); const s = await app.bridge.get('/standby'); res.standby = s.body; if (/ready/i.test(JSON.stringify(s.body))) break; }
  log('standby-1', res.standby);
  const s = await app.bridge.post('/acp/sessions', { agent: 'claude', folder: proj, lane: 'acp' });
  const pane = s.body.pane_id; log('claude-start', s.body);
  let st;
  for (let i = 0; i < 30; i++) { await sleep(2000); st = (await app.bridge.get(`/acp/sessions/${pane}`)).body; if (st && !st.starting) break; }
  log('set-model', await inv(conn, 'acp_chat_set_config', { paneId: pane, optionId: 'model', value: 'haiku' }));
  log('set-effort', await inv(conn, 'acp_chat_set_config', { paneId: pane, optionId: 'effort', value: 'low' }));
  const nonce = 'zebra' + Math.random().toString(16).slice(2, 6);
  res.nonce = nonce;
  const prompt = `Call the tool run_agent exactly once with agent_type "opencode", project_path ${JSON.stringify(proj.split(path.sep).join('/'))}, task "Reply with exactly the single word ${nonce} and nothing else." and wait_ms 120000. Then write one line: the helper said: <its answer>.`;
  log('send', JSON.stringify((await app.bridge.post(`/panes/${pane}/messages`, { text: prompt })).body));
  const helpers = [];
  for (let i = 0; i < 12; i++) {
    await sleep(2000);
    const h = (await app.bridge.get('/phone/helpers')).body;
    helpers.push(JSON.stringify(h).slice(0, 300));
    const st = (await app.bridge.get(`/acp/sessions/${pane}`)).body;
    if (st.status === 'waiting_input' && !res.dumped) {
      res.dumped = true;
      res.sidebar = (await listInteractive(conn)).filter((x) => x.x < 240).map((x) => `${x.text} @${x.x},${x.y}`);
      const rows = (await listInteractive(conn)).filter((x) => x.x < 240 && !/New agent|Search|Inbox|Team|Add project|companion|Settings|Review|Help|More|Resize|Bring my|Quick start/i.test(x.text + x.aria));
      for (const r of rows) { const m = await import('./cdp-util.mjs'); await m.mouseClick(conn, r.x, r.y); await sleep(500); }
      await sleep(800);
      res.ui = (await listInteractive(conn)).filter((x) => x.x > 240).map((x) => `${x.tag}[${x.role}] "${x.text}" aria=${x.aria} @${x.x},${x.y}`);
      await screenshot(conn, path.join(outDir, 'a1-waiting.png'));
      res.permissions = JSON.stringify(st.permissions).slice(0, 1500);
      await app.bridge.post('/acp/sessions/' + pane + '/typing', {});
    }
    if (i % 5 === 0) log('tick' + i, { phase: st.phase, status: st.status, turnInFlight: st.turnInFlight, turn: st.turn });
    if (i > 3 && !st.turnInFlight && st.status !== 'running') break;
  }
  res.helperStates = [...new Set(helpers)];
  log('result', JSON.stringify((await app.bridge.get(`/panes/${pane}/result`)).body));
  const j = path.join(app.dataDir, 'acp', 'journals');
  res.journals = fs.existsSync(j) ? fs.readdirSync(j) : [];
  for (const f of res.journals) { const t = fs.readFileSync(path.join(j, f), 'utf8'); res['journal_' + f] = t.slice(0, 6000); }
  res.dataFiles = fs.readdirSync(app.dataDir);
} catch (e) { res.error = String(e.stack || e); }
finally { await app.stop(); }
fs.writeFileSync(path.join(outDir, 'spike-a1.json'), JSON.stringify(res, null, 2));
console.log(JSON.stringify(res, null, 1));
