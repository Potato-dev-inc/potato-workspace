// Spike (c): can the extracted release exe run real agents with NO login file copied? Starts it (HOME split), opens a Claude chat
// and an OpenCode chat through the bridge and reports what happens in the first minute. Stops only the PID it started.
import fs from 'node:fs';
import path from 'node:path';
import { startApp, ensureCockpit } from '../src/launcher.mjs';
import { sleep } from '../src/cdp.mjs';

const exe = process.argv[2];
const outDir = process.argv[3];
const agents = (process.argv[4] || 'claude,opencode').split(',');
fs.mkdirSync(outDir, { recursive: true });
const runId = 'realtest-agents-' + Math.random().toString(16).slice(2, 6);
const res = { runId, results: {} };
let app;
const short = (x, n = 1500) => JSON.stringify(x).slice(0, n);
try {
  app = await startApp({ exe, realAgents: true, homeMode: 'split', profile: 'realtest', runId, headless: true });
  const conn = await ensureCockpit(app);
  if (agents.includes('claude')) {
    const t0 = Date.now();
    const ev = await conn.send('Runtime.evaluate', { expression: "window.__TAURI_INTERNALS__.invoke('acp_addon_install', { agentId: 'claude' }).then(v => JSON.stringify(v).slice(0, 600), e => 'ERR ' + String(e).slice(0, 600))", awaitPromise: true, returnByValue: true, timeout: 280000 });
    res.addonInstall = { started: ev.result?.value ?? ev.exceptionDetails?.text };
    for (let i = 0; i < 100; i++) {
      await sleep(3000);
      const st = await conn.send('Runtime.evaluate', { expression: "window.__TAURI_INTERNALS__.invoke('acp_addon_status').then(v => JSON.stringify(v), e => JSON.stringify({ err: String(e) }))", awaitPromise: true, returnByValue: true });
      let one = null; try { one = (JSON.parse(st.result?.value).addons || []).find((x) => x.agent === 'claude'); } catch { /* keep */ }
      res.addonInstall.status = one ? { state: one.state, version: one.version, detail: one.detail, last: (one.lines || []).slice(-3) } : st.result?.value?.slice(0, 300);
      if (one && one.state !== 'installing') break;
    }
    res.addonInstall.ms = Date.now() - t0;
  }
  const proj = path.join(app.dirs.projects, 'p1');
  fs.mkdirSync(proj, { recursive: true });
  for (const agent of agents) {
    const r = { };
    const s = await app.bridge.post('/acp/sessions', { agent, folder: proj, lane: 'acp' });
    r.start = { status: s.status, body: short(s.body) };
    const id = s.body?.pane_id;
    if (id) {
      for (let i = 0; i < 30; i++) {
        await sleep(2000);
        const st = await app.bridge.get(`/acp/sessions/${id}`);
        r.state = short(st.body, 1200);
        if (/ready|idle/i.test(JSON.stringify(st.body?.status ?? st.body?.state ?? ''))) break;
      }
    }
    res.results[agent] = r;
  }
  res.logTail = fs.readFileSync(app.logFile, 'utf8').split(/\r?\n/).filter((l) => /acp|adapter|claude|opencode|ERROR|WARN/i.test(l)).slice(-30).map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 300));
} catch (e) { res.error = String(e.stack || e); }
finally { if (app) await app.stop(); }
fs.writeFileSync(path.join(outDir, 'spike-agents.json'), JSON.stringify(res, null, 2));
console.log(JSON.stringify(res, null, 2));
