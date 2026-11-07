#!/usr/bin/env node
/**
 * Release build step: puts the official Node.js runtime (with npm) inside the app, so a person never has
 * to install Node. npm is staged too: the ACP installer (acp/install.rs) runs npm from the folder next to
 * the node binary.
 *
 * Windows: node-v<NODE_VERSION>-win-x64.zip  -> resources/node/node.exe + npm.cmd / npx.cmd
 * macOS:   node-v<NODE_VERSION>-darwin-<arch>.tar.gz -> resources/node/node + npm / npx shell shims
 * Linux:   node-v<NODE_VERSION>-linux-x64.tar.gz     -> resources/node/node + npm / npx shell shims
 *
 * Every download is checked against https://nodejs.org/dist/v<NODE_VERSION>/SHASUMS256.txt, cached
 * outside the repo (PM_BUILD_CACHE, else under the user's cache folder), and the licence text is
 * copied to resources/legal/LICENSES/Node.txt.
 *
 * The version is pinned here: change NODE_VERSION on purpose, never by accident.
 * PM_SKIP_NODE=1 skips it for a build that is not for release.
 */
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const NODE_VERSION = '22.20.0';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const res = join(root, 'packages/app/src-tauri/resources');
const base = `https://nodejs.org/dist/v${NODE_VERSION}`;

if (process.env.PM_SKIP_NODE === '1') {
  console.error('[fetch-node] PM_SKIP_NODE=1: skipped');
  process.exit(0);
}

function nodeArchive() {
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;
  if (process.platform === 'win32') {
    const name = `node-v${NODE_VERSION}-win-${arch}.zip`;
    return { name, folder: name.replace(/\.zip$/, ''), kind: 'zip' };
  }
  if (process.platform === 'darwin') {
    const name = `node-v${NODE_VERSION}-darwin-${arch}.tar.gz`;
    return { name, folder: name.replace(/\.tar\.gz$/, ''), kind: 'tar.gz' };
  }
  const name = `node-v${NODE_VERSION}-linux-${arch}.tar.gz`;
  return { name, folder: name.replace(/\.tar\.gz$/, ''), kind: 'tar.gz' };
}

const archive = nodeArchive();
const cacheRoot = process.env.PM_BUILD_CACHE || join(process.env.LOCALAPPDATA || join(homedir(), '.cache'), 'potato-workspace-build-cache');
const cache = join(cacheRoot, `node-v${NODE_VERSION}-${process.platform}-${process.arch}`);
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

mkdirSync(cache, { recursive: true });
const download = join(cache, archive.name);
const sums = (await get(`${base}/SHASUMS256.txt`)).toString('utf8');
const line = sums.split(/\r?\n/).find((l) => l.trim().endsWith(`  ${archive.name}`));
if (!line) throw new Error(`${archive.name} is not in SHASUMS256.txt`);
const expected = line.trim().split(/\s+/)[0].toLowerCase();

if (!existsSync(download) || sha(download) !== expected) {
  console.error(`[fetch-node] downloading ${archive.name}`);
  writeFileSync(`${download}.part`, await get(`${base}/${archive.name}`));
  if (sha(`${download}.part`) !== expected) {
    rmSync(`${download}.part`, { force: true });
    throw new Error(`${archive.name}: sha256 does not match SHASUMS256.txt`);
  }
  renameSync(`${download}.part`, download);
}

const unpacked = join(cache, 'unpacked');
const marker = process.platform === 'win32' ? 'node.exe' : join('bin', 'node');
if (!existsSync(join(unpacked, archive.folder, marker))) {
  rmSync(unpacked, { recursive: true, force: true });
  mkdirSync(unpacked, { recursive: true });
  const args =
    archive.kind === 'zip'
      ? ['-xf', download, '-C', unpacked]
      : ['-xzf', download, '-C', unpacked];
  // On Windows prefer its own bsdtar: a GNU tar earlier on PATH reads "C:" as a host name.
  const tar =
    process.platform === 'win32'
      ? join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe')
      : 'tar';
  const r = spawnSync(existsSync(tar) ? tar : 'tar', args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`could not unpack ${archive.name} (tar failed)`);
}

const folder = join(unpacked, archive.folder);
const dest = join(res, 'node');
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

if (process.platform === 'win32') {
  const nodeExe = join(folder, 'node.exe');
  for (const need of ['node.exe', 'npm.cmd', 'npx.cmd', join('node_modules', 'npm', 'package.json')]) {
    if (!existsSync(join(folder, need))) throw new Error(`the Node.js archive has no ${need}`);
  }
  // Node's own SHASUMS file also lists the bare exe: check the unpacked one against it as well.
  const exeLine = sums.split(/\r?\n/).find((l) => l.trim().endsWith('  win-x64/node.exe'));
  if (exeLine && sha(nodeExe) !== exeLine.trim().split(/\s+/)[0].toLowerCase()) {
    throw new Error('node.exe does not match SHASUMS256.txt');
  }
  // The whole runtime: node.exe, the npm and npx shims, and npm's own folder (the shims run node_modules/npm).
  cpSync(nodeExe, join(dest, 'node.exe'));
  cpSync(join(folder, 'npm.cmd'), join(dest, 'npm.cmd'));
  cpSync(join(folder, 'npx.cmd'), join(dest, 'npx.cmd'));
  cpSync(join(folder, 'node_modules'), join(dest, 'node_modules'), { recursive: true });
} else {
  const nodeBin = join(folder, 'bin', 'node');
  for (const need of [join('bin', 'node'), join('lib', 'node_modules', 'npm', 'package.json')]) {
    if (!existsSync(join(folder, need))) throw new Error(`the Node.js archive has no ${need}`);
  }
  cpSync(nodeBin, join(dest, 'node'));
  cpSync(join(folder, 'lib', 'node_modules'), join(dest, 'node_modules'), { recursive: true });
  // The upstream shims are symlinks into lib/; write real scripts so the bundle survives any copy that
  // does not preserve symlinks.
  writeFileSync(
    join(dest, 'npm'),
    '#!/bin/sh\nbasedir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$basedir/node" "$basedir/node_modules/npm/bin/npm-cli.js" "$@"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(dest, 'npx'),
    '#!/bin/sh\nbasedir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$basedir/node" "$basedir/node_modules/npm/bin/npx-cli.js" "$@"\n',
    { mode: 0o755 },
  );
  chmodSync(join(dest, 'node'), 0o755);
}

mkdirSync(join(res, 'legal', 'LICENSES'), { recursive: true });
cpSync(join(folder, 'LICENSE'), join(res, 'legal', 'LICENSES', 'Node.txt'));
console.error(
  `[fetch-node] node ${NODE_VERSION} ${process.platform}-${process.arch} + npm staged (sha256 ${expected.slice(0, 12)}...)`,
);
