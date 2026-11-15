// Proves a real-app run left the founder's own install and data alone: a snapshot before, a snapshot after, a diff.
// Read-only: it only lists and hashes. It never opens a file for writing, never prints a file's content.
//
// What counts:
//  - the installed app folder (count, bytes, newest mtime, hash of the exe): must be identical (FAIL otherwise)
//  - the MCP entries named potato-workspace* in the agent configs (hash of each entry only): must be identical (FAIL)
//  - the founder's data folders (Roaming + Local, default profile only): count / bytes / newest mtime. The founder's
//    own app may be running and writing there, so a change is INFO, with the "founder's app running" flag next to it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const home = () => process.env.E2E_REAL_USERPROFILE || os.homedir();
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex').slice(0, 16);
/** An MCP entry as a hash plus whether it mentions this run's folders (the text itself is never kept). */
const ent = (text, needles = []) => ({ h: sha(text), m: needles.some((n) => n && text.toLowerCase().includes(String(n).toLowerCase())) });

function walkStats(dir, { maxFiles = 200000, skip = () => false } = {}) {
  const out = { exists: false, count: 0, bytes: 0, newest: 0 };
  let st; try { st = fs.statSync(dir); } catch { return out; }
  out.exists = true; out.newest = st.mtimeMs;
  const stack = [dir];
  while (stack.length && out.count < maxFiles) {
    const d = stack.pop();
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (skip(p)) continue;
      if (e.isDirectory()) { stack.push(p); continue; }
      try { const s = fs.statSync(p); out.count++; out.bytes += s.size; if (s.mtimeMs > out.newest) out.newest = s.mtimeMs; } catch { /* vanished */ }
    }
  }
  return out;
}

function hashFile(f) { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16); } catch { return null; } }

function claudeEntries(needles) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(home(), '.claude.json'), 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(doc.mcpServers || {})) if (/^potato-workspace/.test(k)) out[k] = ent(JSON.stringify(v), needles);
    return out;
  } catch { return null; }
}
function codexEntries(needles) {
  try {
    const text = fs.readFileSync(path.join(home(), '.codex', 'config.toml'), 'utf8');
    const out = {};
    const re = /^\[mcp_servers\.(potato-workspace[^\]\s]*)\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/gm;
    let m; while ((m = re.exec(text))) out[m[1]] = ent(m[2].trim(), needles);
    return out;
  } catch { return null; }
}
function opencodeEntries(needles) {
  const out = {};
  for (const f of [path.join(home(), '.config', 'opencode', 'opencode.json'), path.join(process.env.APPDATA_REAL || path.join(home(), 'AppData', 'Roaming'), 'opencode', 'opencode.json')]) {
    try {
      const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const [k, v] of Object.entries(doc.mcp || {})) if (/^potato-workspace/.test(k)) out[`${path.basename(path.dirname(f))}:${k}`] = ent(JSON.stringify(v), needles);
    } catch { /* none */ }
  }
  return out;
}

function founderAppRunning() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq puppet_master_app.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return /puppet_master_app\.exe/i.test(r.stdout || '');
}

export function installDirOf(env = process.env) { return path.join(env.ProgramFiles || 'C:\\Program Files', 'Potato Workspace'); }

export function snapshot(needles = []) {
  const roaming = path.join(process.env.E2E_REAL_APPDATA || path.join(home(), 'AppData', 'Roaming'), 'com.potatodev.workspace');
  const local = path.join(process.env.E2E_REAL_LOCALAPPDATA || path.join(home(), 'AppData', 'Local'), 'com.potatodev.workspace');
  const inst = installDirOf();
  const exe = path.join(inst, 'puppet_master_app.exe');
  const logsSkip = (p) => /[\\/](logs?|cache|EBWebView|webview)[\\/]/i.test(p);
  return {
    at: new Date().toISOString(),
    founderAppRunning: founderAppRunning(),
    installDir: { dir: inst, ...walkStats(inst), exeHash: hashFile(exe) },
    dataRoaming: { dir: roaming, ...walkStats(roaming, { skip: logsSkip }) },
    dataLocal: { dir: local, ...walkStats(local, { skip: logsSkip }) },
    mcp: { claude: claudeEntries(needles), codex: codexEntries(needles), opencode: opencodeEntries(needles) },
  };
}

/** @returns {{ ok: boolean, hard: string[], info: string[] }} hard = a real change to what must not change. */
export function compare(a, b) {
  const hard = [], info = [];
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const strip = (o) => ({ exists: o.exists, count: o.count, bytes: o.bytes, newest: o.newest });
  const i1 = { ...strip(a.installDir), exe: a.installDir.exeHash }, i2 = { ...strip(b.installDir), exe: b.installDir.exeHash };
  if (!eq(i1, i2)) hard.push(`the installed app folder changed: ${JSON.stringify(i1)} -> ${JSON.stringify(i2)}`);
  // the "-dev" entries belong to other agents' dev builds, which rewrite them all night: INFO, unless the new value mentions this run
  for (const host of ['claude', 'codex', 'opencode']) {
    const x = a.mcp[host] || {}, y = b.mcp[host] || {};
    for (const name of new Set([...Object.keys(x), ...Object.keys(y)])) {
      const changed = JSON.stringify(x[name]?.h) !== JSON.stringify(y[name]?.h);
      if (!changed) continue;
      const devish = /-dev$/.test(name);
      if (!devish || y[name]?.m) hard.push(`${host} MCP entry ${name} changed${y[name]?.m ? ' and now points into this run' : ''}`);
      else info.push(`${host} MCP entry ${name} changed during the run; it is a dev-build entry that other dev apps rewrite, and it does not mention this run`);
    }
  }
  for (const k of ['dataRoaming', 'dataLocal']) {
    if (!eq(strip(a[k]), strip(b[k]))) info.push(`${k} changed (${JSON.stringify(strip(a[k]))} -> ${JSON.stringify(strip(b[k]))}); founder's app running before=${a.founderAppRunning} after=${b.founderAppRunning}`);
  }
  return { ok: hard.length === 0, hard, info };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(snapshot(), null, 2));
}
