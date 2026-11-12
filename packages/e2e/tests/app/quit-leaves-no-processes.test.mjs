// Quitting the app (the same call the Quit button makes) ends the app and every program it started: no agent, terminal
// host or helper is left running on the PC.
import { spawnSync } from 'node:child_process';
import { calm } from './_area.mjs';

export const meta = {
  id: 'app.quit-leaves-no-processes',
  title: 'Quitting the app leaves no agent or helper process behind',
  area: 'app',
  tags: ['smoke', 'lifecycle'],
  fresh: true,
};

/** Every descendant pid of `root` (children, grandchildren ...), from one process listing. Windows only. */
function descendants(root) {
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const parent = new Map();
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid) parent.set(pid, ppid);
  }
  const found = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of parent) if (!found.has(pid) && (ppid === root || found.has(ppid))) { found.add(pid); grew = true; }
  }
  return [...found];
}

function alivePids(pids) {
  if (!pids.length) return [];
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }`], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return (r.stdout || '').split(/\r?\n/).map((s) => +s.trim()).filter(Boolean);
}

export async function run(t) {
  if (process.platform !== 'win32') t.skip('the process listing used here is Windows only');
  await calm(t);

  await t.step('Start two fake agents so there is something to clean up');
  await t.spawnPane('nimbus', { cwd: t.project('quit-a') });
  await t.spawnPane('nimbus', { cwd: t.project('quit-b') });
  const kids = descendants(t.app.pid);
  t.log(`the app has ${kids.length} child process(es)`);
  t.expect.ok(kids.length >= 2, 'the agents run as child processes of the app');

  await t.step('Quit the app');
  await t.page.eval(`window.__TAURI_INTERNALS__.invoke('exit_app').then(() => true, () => true)`).catch(() => {});

  await t.step('The app is gone');
  await t.expect.eventually(() => !t.app.alive(), { timeout: 30000, message: 'the app process ended' });

  await t.step('Nothing it started is still running');
  await t.expect.eventually(() => alivePids([t.app.pid, ...kids]).length === 0, { timeout: 30000, message: 'every child process ended' });
}
