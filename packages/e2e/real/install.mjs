// Puts a copy of the release MSI's files into a folder the person can write, WITHOUT elevation and WITHOUT running the
// installer: `msiexec /a` (administrative extract) needs an elevated shell for a per-machine package (from a normal
// shell it waits on a UAC prompt on the primary screen and then fails), so the files are laid out here from the MSI's
// own tables:
//   1. 7-Zip pulls the embedded cabinet out of the MSI (the MSI is only read, never written)
//   2. `expand.exe` (Windows) unpacks the cabinet; every file is named by its File-table key
//   3. the File, Component and Directory tables (Windows Installer COM, read-only) say where each key belongs
// The result is the same tree an install would make (same file names, same folders). It is NOT an install: no shortcuts, no
// registry, no URL handler, no uninstall entry. A report must say "ran from an extracted copy of the MSI".
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trash } from './util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEVENZ = process.env.E2E_7Z || 'C:\\Program Files\\7-Zip\\7z.exe';

export const sha256File = (f) => new Promise((res, rej) => {
  const h = crypto.createHash('sha256'); const s = fs.createReadStream(f);
  s.on('data', (d) => h.update(d)); s.on('end', () => res(h.digest('hex'))); s.on('error', rej);
});

export function readTables(msi) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(HERE, 'msi-tables.ps1'), '-Path', msi], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`could not read the MSI tables: ${r.stderr || r.stdout}`);
  const files = [], comps = new Map(), dirs = new Map();
  for (const line of r.stdout.split(/\r?\n/)) {
    const c = line.split('\t');
    if (c[0] === 'F') files.push({ key: c[1], comp: c[2], name: c[3] });
    else if (c[0] === 'C') comps.set(c[1], c[2]);
    else if (c[0] === 'D') dirs.set(c[1], { parent: c[2], def: c[3] });
  }
  return { files, comps, dirs };
}

/** Long name of a `SHORT|Long` or `src:target` pair (the target half). */
const longName = (s) => { const t = String(s).split(':').pop(); return t.split('|').pop(); };

/** Relative folder (under the target) of a Directory key. System folders (ProgramFiles64Folder ...) collapse to the target. */
export function dirPath(key, dirs, cache = new Map()) {
  if (cache.has(key)) return cache.get(key);
  const d = dirs.get(key);
  let rel;
  if (!d || !d.parent || d.parent === key) rel = '';
  else {
    const name = longName(d.def);
    const base = dirPath(d.parent, dirs, cache);
    rel = name === '.' || /^(TARGETDIR|SourceDir)$/i.test(name) ? base : path.join(base, name);
  }
  cache.set(key, rel);
  return rel;
}

/**
 * Extract `msi` (read only) into `target` (made if needed, must be empty). Returns { target, files, msiSha256 }.
 * Refuses a target under the real Program Files or Windows folder.
 */
export async function extractMsi(msi, target, { workDir } = {}) {
  const abs = path.resolve(target);
  if (/^[a-z]:\\(program files|windows)/i.test(abs)) throw new Error(`refusing to extract into ${abs}`);
  if (!fs.existsSync(msi)) throw new Error(`MSI not found: ${msi}`);
  if (fs.existsSync(abs) && fs.readdirSync(abs).length) throw new Error(`the target is not empty: ${abs}`);
  const work = workDir || path.join(path.dirname(abs), `.work-${path.basename(abs)}`);
  fs.mkdirSync(work, { recursive: true });
  const before = await sha256File(msi);
  const seven = spawnSync(SEVENZ, ['x', '-y', `-o${work}`, msi, '*.cab'], { encoding: 'utf8', windowsHide: true });
  const cabs = fs.readdirSync(work).filter((f) => /\.cab$/i.test(f));
  if (seven.status !== 0 || !cabs.length) throw new Error(`7-Zip could not read the cabinet out of the MSI: ${seven.stderr || seven.stdout}`);
  const flat = path.join(work, 'flat');
  fs.mkdirSync(flat, { recursive: true });
  for (const cab of cabs) {
    const ex = spawnSync(path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'expand.exe'), [path.join(work, cab), '-F:*', flat], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
    if (ex.status !== 0) throw new Error(`expand failed for ${cab}: ${ex.stderr || ex.stdout}`);
  }
  const { files, comps, dirs } = readTables(msi);
  const cache = new Map();
  let placed = 0;
  const missing = [];
  for (const f of files) {
    const src = path.join(flat, f.key);
    if (!fs.existsSync(src)) { missing.push(f.key); continue; }
    const dest = path.join(abs, dirPath(comps.get(f.comp), dirs, cache), longName(f.name));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    placed++;
  }
  if (missing.length) throw new Error(`${missing.length} files of the File table are not in the cabinet (first: ${missing[0]})`);
  trash(work, 'extract-work');
  const after = await sha256File(msi);
  if (before !== after) throw new Error('the MSI changed while it was read');
  return { target: abs, files: placed, msiSha256: before };
}

/** The app exe and the MCP exe inside an extracted tree. */
export function findExes(target) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'puppet_master_app.exe') out.app = p;
      else if (e.name === 'puppet-master-mcp.exe') out.mcp = p;
    }
  };
  walk(target);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [msi, target] = process.argv.slice(2);
  const r = await extractMsi(msi, target);
  console.log(JSON.stringify({ ...r, ...findExes(r.target) }, null, 2));
}
