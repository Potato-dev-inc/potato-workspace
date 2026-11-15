// Dev helper: opens each main screen of the extracted app and lists what is clickable there, to write screens.mjs from facts.
import fs from 'node:fs';
import path from 'node:path';
import { startApp, ensureCockpit } from '../src/launcher.mjs';
import { listInteractive, clickText, screenshot } from './cdp-util.mjs';

const [exe, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const app = await startApp({ exe, realAgents: true, homeMode: 'split', profile: 'realtest', runId: 'realtest-explore-' + Math.random().toString(16).slice(2, 6), headless: true });
const out = {};
try {
  const conn = await ensureCockpit(app);
  const dump = async (name) => {
    const items = await listInteractive(conn);
    out[name] = items.map((x) => `${x.tag}${x.role ? '[' + x.role + ']' : ''} "${x.text}"${x.aria ? ' aria=' + x.aria : ''}${x.title ? ' title=' + x.title : ''} @${x.x},${x.y} ${x.w}x${x.h}${x.disabled ? ' DISABLED' : ''}`);
    await screenshot(conn, path.join(outDir, `explore-${name}.png`));
  };
  await dump('start');
  const { mouseClick } = await import('./cdp-util.mjs');
  await mouseClick(conn, 24, 800); await new Promise((r) => setTimeout(r, 600)); await dump('MoreMenu');
  await conn.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await clickText(conn, 'Settings'); await clickText(conn, 'Look and feel'); await dump('LookAndFeel');
  for (const name of ['Connect', 'Helpers']) { await clickText(conn, name); await dump('S-' + name); }
  for (const name of []) {
    const ok = await clickText(conn, name);
    out[name + '_clicked'] = ok;
    await dump(name);
  }
} catch (e) { out.error = String(e.stack || e); }
finally { await app.stop(); }
fs.writeFileSync(path.join(outDir, 'explore.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1).slice(0, 9000));
