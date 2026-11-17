#!/usr/bin/env node
/**
 * The tools version of the built-in tools (Node.js, MinGit, cloudflared) and the list of files that prove a tools folder
 * is whole. App-only updates (docs/features/app-only-updates.md) take the tools from a folder that has this version.
 *
 *   node scripts/make-tools-manifest.mjs                  write packages/app/src-tauri/resources/tools-manifest.json
 *   node scripts/make-tools-manifest.mjs --bump           the same, and raise toolsVersion by one (a tool changed)
 *   node scripts/make-tools-manifest.mjs --check          fail when a tool changed but toolsVersion did not go up
 *   --resources <dir>                                     read the staged tools from <dir> (default src-tauri/resources)
 *
 * `toolsVersion` is a whole number. It goes up by one whenever any of the three tools changes: a new pinned version in
 * fetch-node.mjs / fetch-git.mjs / fetch-cloudflared.mjs, or a different file in the staged folders. The file is compiled
 * into the app and also ships in the full installer, so a tools folder can say which version it is.
 *
 * `--check` needs no staged tools to compare the pinned versions; with them it also compares every listed file and the
 * file count of each folder. The manifest is written only for Windows layouts (the installer is Windows only).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// PM_TOOLS_MANIFEST points the script at another file (the tests do).
const manifestPath = process.env.PM_TOOLS_MANIFEST || join(root, 'packages/app/src-tauri/resources/tools-manifest.json');

/** The files whose size and sha256 are recorded (relative to the resources folder). Executables and the launchers. */
export const HASHED_FILES = [
  'node/node.exe',
  'node/npm.cmd',
  'node/npx.cmd',
  'git/cmd/git.exe',
  'git/ucrt64/bin/git.exe',
  'git/ucrt64/bin/git-remote-https.exe',
  'git/ucrt64/bin/git-http-fetch.exe',
  'bin/cloudflared.exe',
];
/** Folders whose number of files is recorded too (a copy that lost files is not whole). */
export const COUNTED_FOLDERS = ['node', 'git'];

/** The version a fetch script pins, read from its text (the scripts download when imported, so they are not imported). */
export function pinnedVersion(script, name) {
  const text = readFileSync(join(root, 'scripts', script), 'utf8');
  const m = new RegExp(`export const ${name}\\s*=\\s*'([^']+)'`).exec(text);
  if (!m) throw new Error(`${script}: no ${name} found`);
  return m[1];
}

export function pinnedVersions() {
  return {
    node: pinnedVersion('fetch-node.mjs', 'NODE_VERSION'),
    git: pinnedVersion('fetch-git.mjs', 'GIT_VERSION'),
    cloudflared: pinnedVersion('fetch-cloudflared.mjs', 'CLOUDFLARED_VERSION'),
  };
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function countFiles(dir) {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    n += statSync(p).isDirectory() ? countFiles(p) : 1;
  }
  return n;
}

/** What the staged tools look like now: `{ files: [...], counts: {...} }`. Throws when a listed file is missing. */
export function measure(resources) {
  const files = HASHED_FILES.map((rel) => {
    const p = join(resources, rel);
    if (!existsSync(p)) throw new Error(`not staged: ${rel} (run fetch-node/fetch-git/fetch-cloudflared first)`);
    return { path: rel, size: statSync(p).size, sha256: sha256(p) };
  });
  const counts = {};
  for (const f of COUNTED_FOLDERS) {
    const p = join(resources, f);
    if (!existsSync(p)) throw new Error(`not staged: ${f}/`);
    counts[f] = countFiles(p);
  }
  return { files, counts };
}

/** Pure: why the committed manifest does not match what is pinned or staged now. Empty means it matches. */
export function differences(manifest, versions, measured) {
  const out = [];
  for (const k of ['node', 'git', 'cloudflared']) if (manifest[k] !== versions[k]) out.push(`${k}: manifest has ${manifest[k]}, fetch script pins ${versions[k]}`);
  if (measured) {
    for (const f of measured.files) {
      const m = (manifest.files ?? []).find((x) => x.path === f.path);
      if (!m) out.push(`${f.path}: not in the manifest`);
      else if (m.size !== f.size || m.sha256 !== f.sha256) out.push(`${f.path}: the staged file differs from the manifest`);
    }
    for (const [k, n] of Object.entries(measured.counts)) if (manifest.counts?.[k] !== n) out.push(`${k}/: ${n} files staged, manifest says ${manifest.counts?.[k]}`);
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const flag = (n) => args.includes(n);
  const ri = args.indexOf('--resources');
  const resources = ri >= 0 ? args[ri + 1] : join(root, 'packages/app/src-tauri/resources');
  const versions = pinnedVersions();
  const current = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;

  if (flag('--check')) {
    if (!current) {
      console.error('[tools-manifest] no tools-manifest.json: run node scripts/make-tools-manifest.mjs');
      process.exit(1);
    }
    let measured = null;
    try {
      measured = measure(resources);
    } catch {
      console.error('[tools-manifest] tools not staged here: comparing the pinned versions only');
    }
    const diff = differences(current, versions, measured);
    if (diff.length) {
      console.error(`[tools-manifest] a tool changed but toolsVersion is still ${current.toolsVersion}:\n  ${diff.join('\n  ')}\nRun: node scripts/make-tools-manifest.mjs --bump`);
      process.exit(1);
    }
    console.error(`[tools-manifest] ok: toolsVersion ${current.toolsVersion} matches the tools`);
    return;
  }

  const measured = measure(resources);
  const fresh = { toolsVersion: current?.toolsVersion ?? 1, ...versions, counts: measured.counts, files: measured.files };
  if (current) {
    const changed = differences(current, versions, measured);
    if (changed.length && !flag('--bump')) {
      console.error(`[tools-manifest] the tools changed:\n  ${changed.join('\n  ')}\nRun again with --bump to raise toolsVersion to ${current.toolsVersion + 1}.`);
      process.exit(1);
    }
    if (changed.length && flag('--bump')) fresh.toolsVersion = current.toolsVersion + 1;
    if (!changed.length && flag('--bump')) console.error('[tools-manifest] nothing changed: --bump ignored');
  }
  writeFileSync(manifestPath, JSON.stringify(fresh, null, 2) + '\n');
  console.error(`[tools-manifest] wrote toolsVersion ${fresh.toolsVersion} (${measured.files.length} files hashed)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
