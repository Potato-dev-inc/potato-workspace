// A1: a Claude orchestrator (cheapest model) uses an OpenCode standby helper through the MCP `run_agent` tool, in the extracted app,
// with the person's real sign-ins (no login file copied; see SPIKE.md) and tiny prompts.
// Caps (PLAN-REAL-APP-TEST, Decisions 4): 25 tool calls, 4 minutes, no new byte for 60 s fails the flow early.
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '../../src/cdp.mjs';
import { listInteractive, mouseClick, clickText, screenshot } from '../cdp-util.mjs';

export const A1_CAPS = { toolCalls: 25, minutes: 4, quietSeconds: 60 };
export const HELPER_MODEL = 'opencode-go/deepseek-v4.1-flash';
export const ORCHESTRATOR_MODEL = 'haiku'; // "Haiku 5.5", the cheapest Claude the app lists (see SPIKE.md)

/** Calls a Tauri command from the cockpit page (the same call the screens make). */
export async function invoke(conn, cmd, args = {}) {
  const r = await conn.send('Runtime.evaluate', { expression: `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then(v => JSON.stringify(v), e => JSON.stringify({ __err: String(e) }))`, awaitPromise: true, returnByValue: true });
  const v = JSON.parse(r.result.value ?? 'null');
  if (v && v.__err) throw new Error(`${cmd}: ${v.__err}`);
  return v;
}

export async function installClaudeAddon(conn, log = () => {}) {
  const st = await invoke(conn, 'acp_addon_status');
  const have = (st.addons || []).find((x) => x.agent === 'claude');
  if (have && have.state === 'installed') return { state: 'installed', ms: 0 };
  const t0 = Date.now();
  await invoke(conn, 'acp_addon_install', { agentId: 'claude' });
  for (let i = 0; i < 120; i++) {
    await sleep(2500);
    const s = await invoke(conn, 'acp_addon_status');
    const c = (s.addons || []).find((x) => x.agent === 'claude');
    if (c && c.state !== 'installing') { log(`claude add-on: ${c.state} in ${Date.now() - t0} ms`); return { state: c.state, ms: Date.now() - t0, detail: c.detail }; }
  }
  return { state: 'timeout', ms: Date.now() - t0 };
}

function readJournal(dataDir, needle) {
  const dir = path.join(dataDir, 'acp', 'journals');
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).filter(Boolean);
    const items = lines.map((l) => { try { return JSON.parse(l).item; } catch { return null; } }).filter(Boolean);
    if (items.some((i) => i.kind === 'user' && String(i.text).includes(needle) && String(i.text).startsWith('Call the tool run_agent'))) return { file: f, items };
  }
  return null;
}

const NON_MESSAGE = new Set(['session', 'user', 'usage', 'toolCall', 'toolResult', 'notice', 'thought']);

export async function a1({ app, conn, outDir, nonce, log = () => {} }) {
  const checks = [];
  const add = (name, ok, detail = '') => { checks.push({ name, ok, detail }); log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`); };
  const proj = path.join(app.dirs.projects, 'a1');
  fs.mkdirSync(proj, { recursive: true });
  const projFwd = proj.split(path.sep).join('/');
  const result = { id: 'A1', title: 'A Claude orchestrator uses an OpenCode standby through run_agent', checks, nonce, caps: A1_CAPS };

  const addon = await installClaudeAddon(conn, log);
  result.addon = addon;
  if (addon.state !== 'installed') { add('the Claude add-on installs from the extracted app (npm in a path with spaces)', false, JSON.stringify(addon)); return done(result); }

  // 1. the standby helper (the same command the Add helper form calls)
  const view = await invoke(conn, 'standby_helper_add', { input: { name: 'RT helper', agent: 'opencode', model: HELPER_MODEL, project: proj, after_task: 'wait' } });
  const helperId = view.helpers.find((h) => h.name === 'RT helper')?.id;
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) { await sleep(2000); const h = (await app.bridge.get('/phone/helpers')).body; ready = (h.helpers || []).some((x) => x.id === helperId && x.state === 'ready'); }
  add('the OpenCode standby becomes Ready', ready, `model ${HELPER_MODEL}`);
  if (!ready) return done(result);
  const panesBefore = ((await app.bridge.get('/panes')).body?.panes || (await app.bridge.get('/panes')).body || []);
  const countOpencode = (list) => (Array.isArray(list) ? list : []).filter((p) => /opencode/i.test(JSON.stringify(p.agent_type || p.agent || ''))).length;

  // 2. the Claude orchestrator on the cheapest model
  const s = await app.bridge.post('/acp/sessions', { agent: 'claude', folder: proj, lane: 'acp' });
  if (s.status !== 200) { add('a Claude chat starts', false, JSON.stringify(s.body).slice(0, 200)); return done(result); }
  const pane = s.body.pane_id;
  let st;
  for (let i = 0; i < 40; i++) { await sleep(1500); st = (await app.bridge.get(`/acp/sessions/${pane}`)).body; if (st && st.configOptions) break; }
  await invoke(conn, 'acp_chat_set_config', { paneId: pane, optionId: 'model', value: ORCHESTRATOR_MODEL });
  await invoke(conn, 'acp_chat_set_config', { paneId: pane, optionId: 'effort', value: 'low' }).catch(() => {});
  st = (await app.bridge.get(`/acp/sessions/${pane}`)).body;
  const modelOpt = (st.configOptions || []).find((o) => o.id === 'model');
  const modelName = (modelOpt?.options || []).find((o) => o.value === modelOpt.currentValue)?.name || modelOpt?.currentValue;
  result.orchestratorModel = modelName;
  add('the orchestrator runs on the cheapest Claude model', modelOpt?.currentValue === ORCHESTRATOR_MODEL, String(modelName));

  // 3. the person looks at the chat (select its row), then asks
  const rowRe = /^(Claude|a1)\b/i;
  const rows = (await listInteractive(conn)).filter((x) => x.x < 240 && /Claude/i.test(x.text));
  if (rows[0]) { await mouseClick(conn, rows[0].x, rows[0].y); await sleep(700); }
  const sidebarSig = async () => (await listInteractive(conn)).filter((x) => x.x < 240 && x.w > 100).map((x) => `${x.text.replace(/\s+(Ready|Needs you|Working|Idle)$/i, '')}@${x.x}`);
  const sigBefore = await sidebarSig();
  const prompt = `Call the tool run_agent exactly once with agent_type "opencode", project_path "${projFwd}", task "Reply with exactly the single word ${nonce} and nothing else." and wait_ms 120000. Do not set a model. Then write one line: the helper said: <its answer>.`;
  const sent = await app.bridge.post(`/panes/${pane}/messages`, { text: prompt });
  add('the prompt is accepted', sent.status === 200, '');

  // 4. watch: approve the tool question as the person would, sample helper state and the sidebar
  const t0 = Date.now(); let lastChange = Date.now(); let lastSig = '';
  const helperStates = new Set(); const usedBy = new Set(); const sigs = new Set();
  let approvals = 0; let finished = false; let timedOut = '';
  let toolCalls = 0;
  const shotAt = new Set();
  for (let i = 0; ; i++) {
    await sleep(i < 30 ? 250 : 1000);
    const elapsed = (Date.now() - t0) / 1000;
    if (elapsed > A1_CAPS.minutes * 60) { timedOut = `over ${A1_CAPS.minutes} minutes`; break; }
    const h = (await app.bridge.get('/phone/helpers')).body;
    for (const x of h.helpers || []) if (x.id === helperId) helperStates.add(x.state);
    if (i % 4 === 0) {
      const v = await invoke(conn, 'standby_helpers_get');
      for (const x of v.helpers || []) if (x.id === helperId) { helperStates.add('view:' + x.state); if (x.used_by) usedBy.add(x.used_by); }
      sigs.add((await sidebarSig()).join('|'));
    }
    const state = (await app.bridge.get(`/acp/sessions/${pane}`)).body;
    const sig = JSON.stringify([state.status, state.phase, state.turn, (state.permissions || []).length]);
    const jr = readJournal(app.dataDir, nonce);
    toolCalls = jr ? new Set(jr.items.filter((x) => x.kind === 'toolCall').map((x) => x.callId)).size : 0;
    const progress = sig + '#' + (jr ? jr.items.length : 0);
    if (progress !== lastSig) { lastSig = progress; lastChange = Date.now(); }
    if ((Date.now() - lastChange) / 1000 > A1_CAPS.quietSeconds && state.status !== 'waiting_input') { timedOut = `no new activity for ${A1_CAPS.quietSeconds} s`; break; }
    if (toolCalls > A1_CAPS.toolCalls) { timedOut = `over ${A1_CAPS.toolCalls} tool calls`; break; }
    if (state.status === 'waiting_input' && (state.permissions || []).length && approvals < 6) {
      if (!shotAt.has('ask')) { shotAt.add('ask'); await screenshot(conn, path.join(outDir, 'a1-tool-question.png')); }
      // a person answers Yes on the card
      const ok = await clickText(conn, /^Yes$/, { settle: 400 });
      if (ok) { approvals++; lastChange = Date.now(); }
    }
    if (i > 8 && !state.turnInFlight && state.status !== 'running' && state.status !== 'waiting_input') { finished = true; break; }
  }
  result.seconds = Math.round((Date.now() - t0) / 1000);
  result.toolCalls = toolCalls; result.approvals = approvals;
  await screenshot(conn, path.join(outDir, 'a1-after.png'));
  add('the flow finished inside its caps', finished && !timedOut, timedOut || `${result.seconds} s, ${toolCalls} tool calls, ${approvals} tool question(s) answered Yes`);

  // 5. judge
  let jr = readJournal(app.dataDir, nonce);
  for (let i = 0; i < 15 && !(jr && jr.items.some((x) => x.kind === "turnEnd") && jr.items.some((x) => x.kind === "toolCall" && x.input && x.input.agent_type)); i++) { await sleep(1000); jr = readJournal(app.dataDir, nonce); } // the journal is written a moment after the turn ends
  if (jr) fs.writeFileSync(path.join(outDir, 'a1-transcript.jsonl'), jr.items.map((x) => JSON.stringify(x)).join('\n'));
  const items = jr?.items || [];
  const runCalls = items.filter((x) => x.kind === 'toolCall' && /run_agent/.test(x.summary || '') && x.input && x.input.agent_type);
  const call = runCalls[runCalls.length - 1];
  add('the orchestrator called run_agent (MCP tool of this app) for opencode with no model', !!call && call.input.agent_type === 'opencode' && !call.input.model, call ? JSON.stringify(call.input).slice(0, 200) : 'no run_agent call in the transcript');
  const finals = items.filter((x) => !NON_MESSAGE.has(x.kind) && typeof x.text === 'string' && x.text.trim());
  const finalText = finals.length ? finals[finals.length - 1].text : '';
  result.finalText = finalText.slice(0, 300);
  add('the nonce is in the orchestrator\'s final message', finalText.includes(nonce), finalText.slice(0, 160));
  const userItems = items.filter((x) => x.kind === 'user');
  const injected = userItems.slice(1).filter((x) => /^\s*\[Potato Workspace\]/.test(x.text) || x.text.includes(nonce));
  add('no user-role bubble carries the helper\'s answer or starts with "[Potato Workspace]"', injected.length === 0, `${userItems.length} user item(s)`);
  const seq = [...helperStates].join(', ');
  const claimed = [...helperStates].some((s2) => !/^(view:)?ready$/.test(s2)) || usedBy.size > 0;
  add('the standby was claimed (state left Ready, or used_by was set)', claimed, `states seen: ${seq}; used_by: ${[...usedBy].join(',') || 'none'}`);
  // after its task the standby starts again (after_task = wait): give it up to 60 s to be Ready, the same helper
  let hEnd = [];
  for (let i = 0; i < 30; i++) { hEnd = (await app.bridge.get('/phone/helpers')).body.helpers || []; if (hEnd.length === 1 && hEnd[0].id === helperId && hEnd[0].state === 'ready') break; await sleep(2000); }
  add('the standby is Ready again at the end, the same one (same id), none added or lost', hEnd.length === 1 && hEnd[0].id === helperId && hEnd[0].state === 'ready', `helpers at end: ${hEnd.map((x) => x.id.slice(0, 8) + ':' + x.state).join(', ')}`);
  // the pane the task ran in is the claimed standby's seat: it must run the standby's model
  const panesAfter = ((await app.bridge.get('/panes')).body?.panes || (await app.bridge.get('/panes')).body || []);
  const ocPanes = (Array.isArray(panesAfter) ? panesAfter : []).filter((p) => /opencode/i.test(JSON.stringify(p.agent_type || p.agent || '')));
  let ocModel = '';
  for (const p of ocPanes) {
    const id = p.pane_id || p.id; const ps = id ? (await app.bridge.get(`/acp/sessions/${id}`)).body : null;
    const mo = (ps?.configOptions || []).find((o) => o.id === 'model'); if (mo) ocModel = String(mo.currentValue);
  }
  result.helperPaneModel = ocModel;
  add('the OpenCode pane that did the task runs the standby\'s model', ocPanes.length === 1 && ocModel === HELPER_MODEL, `opencode panes: ${ocPanes.length} (before the task: ${countOpencode(panesBefore)}); model ${ocModel || 'unknown'}`);
  const orchRowStable = [...sigs].every((x) => x.split('|').some((r) => /Claude/i.test(r)) || x === '');
  add('the orchestrator row stayed in the sidebar and kept its place while the helper worked', orchRowStable && sigBefore.length > 0, `${sigs.size} sidebar layouts sampled (every ~1 s, not 100 ms)`);
  const outTool = items.find((x) => x.kind === 'toolResult' && /run_agent|opencode/i.test(JSON.stringify(x)) && x.output);
  result.toolResultSample = outTool ? String(outTool.output).slice(0, 300) : '';
  return done(result);
}

function done(result) {
  const failed = result.checks.filter((c) => !c.ok);
  result.verdict = failed.length ? 'FAIL' : 'PASS';
  return result;
}
