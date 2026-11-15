// Spike (b): does the extracted release exe honour the e2e launch variables? Starts it, reaches the cockpit over CDP,
// reports window position, a screenshot, and what the bridge says about agents. Stops only the PID it started.
import fs from 'node:fs';
import path from 'node:path';
import { startApp, ensureCockpit, primaryScreen } from '../src/launcher.mjs';
import { listTargets } from '../src/cdp.mjs';

const exe = process.argv[2];
const outDir = process.argv[3];
fs.mkdirSync(outDir, { recursive: true });
const runId = 'realtest-spike-' + Math.random().toString(16).slice(2, 6);
const res = { runId, exe };
let app;
try {
  app = await startApp({ exe, realAgents: true, homeMode: 'split', profile: 'realtest', runId, headless: true });
  res.pid = app.pid; res.anchor = app.anchor; res.bridgePort = app.bridgePort; res.cdpPort = app.cdpPort; res.dataDir = app.dataDir;
  const conn = await ensureCockpit(app);
  res.targets = (await listTargets(app.cdpPort)).map((t) => `${t.type} ${String(t.url).slice(0, 80)}`);
  const shot = await conn.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'spike-cockpit.png'), Buffer.from(shot.data, 'base64'));
  const b = await conn.send('Runtime.evaluate', { expression: 'JSON.stringify({w:innerWidth,h:innerHeight,title:document.title,text:document.body.innerText.slice(0,300)})', returnByValue: true });
  res.page = JSON.parse(b.result.value);
  const ag = await app.bridge.get('/agents/definitions');
  res.agents = JSON.stringify(ag.body).slice(0, 1500);
  res.primary = primaryScreen();
  res.log = fs.readFileSync(app.logFile, 'utf8').split(/\r?\n/).slice(0, 25);
} catch (e) { res.error = String(e.stack || e); }
finally { if (app) await app.stop(); }
fs.writeFileSync(path.join(outDir, 'spike-launch.json'), JSON.stringify(res, null, 2));
console.log(JSON.stringify(res, null, 2));
