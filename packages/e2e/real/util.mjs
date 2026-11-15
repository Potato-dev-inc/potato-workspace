// Small shared helpers for the real-app check: trash instead of delete, load sampling, process lists, logs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const TRASH = process.env.E2E_TRASH || 'D:\\pm-trash';

/** Moves a file or folder into the trash folder (never deletes). Returns where it went, or null when it was not there. */
export function trash(p, label = 'realtest') {
  if (!p || !fs.existsSync(p)) return null;
  // a rename cannot cross drives: the trash of a drive that is not the trash drive is a folder on that drive
  const sameDrive = path.parse(path.resolve(p)).root.toLowerCase() === path.parse(path.resolve(TRASH)).root.toLowerCase();
  const base = sameDrive ? TRASH : path.join(process.env.TEMP || os.tmpdir(), 'pm-trash');
  fs.mkdirSync(base, { recursive: true });
  const dest = path.join(base, `${label}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}-${path.basename(p)}`);
  for (let i = 0; i < 12; i++) {
    try { fs.renameSync(p, dest); return dest; } catch (e) { if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(e.code)) return null; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); }
  }
  // something holds the folder itself: move what is inside, one entry at a time, and leave the empty shell
  try {
    fs.mkdirSync(dest, { recursive: true });
    let moved = 0;
    for (const name of fs.readdirSync(p)) { try { fs.renameSync(path.join(p, name), path.join(dest, name)); moved++; } catch { /* in use */ } }
    return moved ? `${dest} (partial: the empty folder itself is in use)` : null;
  } catch { return null; }
}

const ps = (script, timeout = 20000) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout });

/** CPU load now, in percent (average over the sample), or null. */
export function cpuLoad() {
  const r = ps('(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average');
  const n = Number((r.stdout || '').trim());
  return Number.isFinite(n) ? n : null;
}

/** How many processes of these image names run now (read only). */
export function countImages(names) {
  const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  const out = {};
  for (const n of names) out[n] = (r.stdout || '').split(/\r?\n/).filter((l) => l.toLowerCase().startsWith(`"${n.toLowerCase()}"`)).length;
  return out;
}

/** Processes whose command line mentions one of `needles` (read only; used to REPORT leftovers). */
export function processesMentioning(needles) {
  const clause = `$_.CommandLine -notlike '*Get-CimInstance*' -and $_.ProcessId -ne ${process.pid} -and (` + needles.map((n) => `$_.CommandLine -like '*${n.replace(/'/g, "''")}*'`).join(' -or ') + ')';
  const r = ps(`Get-CimInstance Win32_Process | Where-Object { ${clause} } | ForEach-Object { "$($_.ProcessId)|$($_.Name)|$($_.ParentProcessId)" }`);
  return (r.stdout || '').split(/\r?\n/).filter(Boolean).map((l) => { const [pid, name, ppid] = l.split('|'); return { pid: +pid, name, ppid: +ppid }; });
}

/** PIDs of `rootPid` and everything below it (read only). */
export function descendants(rootPid) {
  // a process counts as a child only when it was created after its parent (a recycled pid must not pull strangers into the tree)
  const r = ps('Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CreationDate.ToFileTimeUtc())" }');
  const rows = (r.stdout || '').split(/\r?\n/).filter(Boolean).map((l) => l.split('|').map(Number));
  const born = new Map(rows.map(([p, , t]) => [p, t]));
  const kids = new Map();
  for (const [p, pp, t] of rows) { if (born.has(pp) && t >= born.get(pp)) { if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(p); } }
  const out = []; const stack = [rootPid];
  while (stack.length) { const p = stack.pop(); out.push(p); for (const k of kids.get(p) || []) stack.push(k); }
  return out;
}

export function osInfo() { return `${os.type()} ${os.release()} (${os.version()}) ${os.arch()}`; }

export function versionOf(cmd, args = ['--version']) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 20000, shell: process.platform === 'win32' });
  return ((r.stdout || r.stderr || '').trim().split(/\r?\n/)[0] || 'unknown').slice(0, 80);
}

export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export function pidAlive(pid) {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').includes(`"${pid}"`);
}

/** The screen rectangles of every visible top-level window owned by these pids: [{pid, title, x, y, w, h}]. */
export function windowRects(pids) {
  const script = `
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public class RtWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<string> Find(HashSet<uint> pids) {
    var o = new List<string>();
    EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid); if (pids.Contains(pid) && IsWindowVisible(h)) { RECT r; GetWindowRect(h, out r); var sb = new StringBuilder(80); GetWindowText(h, sb, 80); o.Add(pid + "|" + r.L + "|" + r.T + "|" + (r.R - r.L) + "|" + (r.B - r.T) + "|" + sb); } return true; }, IntPtr.Zero);
    return o;
  }
}
'@
$set = New-Object 'System.Collections.Generic.HashSet[uint32]'
foreach ($p in @(${pids.join(',')})) { [void]$set.Add([uint32]$p) }
[RtWin]::Find($set) | ForEach-Object { $_ }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return (r.stdout || '').split(/\r?\n/).filter(Boolean).map((l) => { const [pid, x, y, w, h, ...t] = l.split('|'); return { pid: +pid, x: +x, y: +y, w: +w, h: +h, title: t.join('|') }; });
}

/** "x,y" of the top-left of a non-primary monitor, or null when there is none. The app puts its first window 40,60 inside it. */
export function secondaryAnchor() {
  const r = ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | ForEach-Object { "$($_.Bounds.X),$($_.Bounds.Y),$($_.Bounds.Width),$($_.Bounds.Height)" }`);
  const l = (r.stdout || '').split(/\r?\n/).filter(Boolean)[0];
  if (!l) return null;
  const [x, y, w, h] = l.split(',').map(Number);
  return w >= 1400 && h >= 900 ? `${x},${y}` : null;
}
