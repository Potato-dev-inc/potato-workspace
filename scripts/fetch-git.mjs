#!/usr/bin/env node
/**
 * Release build step: puts Git for Windows (MinGit, 64-bit, the portable zip: no busybox, no installer) inside the
 * app, so the app never needs Git installed.
 *
 *   https://github.com/git-for-windows/git/releases/download/<TAG>/<ASSET>
 *     -> checked against the sha256 pinned below
 *     -> cached outside the repo (%LOCALAPPDATA%\potato-workspace-build-cache, or PM_BUILD_CACHE)
 *     -> packages/app/src-tauri/resources/git/...                     (the whole MinGit tree; gitignored)
 *        and resources/git/cmd/git.exe is what the app puts on its PATH (after the person's own tools)
 *     -> packages/app/src-tauri/resources/legal/LICENSES/Git.txt       (Git's GPL-2.0 licence text)
 *
 * Version and hash are pinned here: change them together, on purpose, never by accident.
 * Where the hash came from: the `digest` GitHub shows for this release asset
 * (gh api repos/git-for-windows/git/releases/latest), read on 2026-11-07 and then confirmed by hashing the download.
 * PM_SKIP_GIT=1 skips the step for a build that is not for release.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const GIT_TAG = 'v2.56.0.windows.4';
export const GIT_VERSION = '2.56.0.4';
export const GIT_ASSET = `MinGit-${GIT_VERSION}-64-bit.zip`;
export const GIT_SHA256 = 'e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877';
export const GIT_SIZE = 39846926;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const res = join(root, 'packages/app/src-tauri/resources');
const url = `https://github.com/git-for-windows/git/releases/download/${GIT_TAG}/${GIT_ASSET}`;

if (process.env.PM_SKIP_GIT === '1') {
  console.error('[fetch-git] PM_SKIP_GIT=1: skipped');
  process.exit(0);
}

const cacheRoot = process.env.PM_BUILD_CACHE || join(process.env.LOCALAPPDATA || join(homedir(), '.cache'), 'potato-workspace-build-cache');
const cache = join(cacheRoot, `mingit-${GIT_VERSION}`);
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

async function get(address) {
  const r = await fetch(address);
  if (!r.ok) throw new Error(`${address}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

mkdirSync(cache, { recursive: true });
const zip = join(cache, GIT_ASSET);
if (!existsSync(zip) || sha(zip) !== GIT_SHA256) {
  console.error(`[fetch-git] downloading ${GIT_ASSET} (${GIT_SIZE} bytes)`);
  const bytes = await get(url);
  writeFileSync(`${zip}.part`, bytes);
  const got = sha(`${zip}.part`);
  if (got !== GIT_SHA256) {
    rmSync(`${zip}.part`, { force: true });
    throw new Error(`${GIT_ASSET}: sha256 ${got} does not match the pinned ${GIT_SHA256}; refusing to stage it`);
  }
  renameSync(`${zip}.part`, zip);
}

const unpacked = join(cache, 'unpacked');
if (!existsSync(join(unpacked, 'cmd', 'git.exe'))) {
  rmSync(unpacked, { recursive: true, force: true });
  mkdirSync(unpacked, { recursive: true });
  // Windows' own bsdtar (a GNU tar earlier on PATH reads "C:" as a host name).
  const tar = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
  const r = spawnSync(existsSync(tar) ? tar : 'tar', ['-xf', zip, '-C', unpacked], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('could not unpack the MinGit zip (tar -xf failed)');
}
if (!existsSync(join(unpacked, 'cmd', 'git.exe'))) throw new Error('MinGit has no cmd/git.exe');

// The whole MinGit tree goes in: git.exe needs its libexec and mingw64 folders beside it.
const dest = join(res, 'git');
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const entry of readdirSync(unpacked)) cpSync(join(unpacked, entry), join(dest, entry), { recursive: true });

// Licence: MinGit ships Git's COPYING / LICENSE text at its root.
const licence = ['COPYING', 'LICENSE.txt', 'LICENSE'].map((n) => join(unpacked, n)).find((p) => existsSync(p));
if (!licence) throw new Error('MinGit has no licence file (COPYING / LICENSE.txt)');
mkdirSync(join(res, 'legal', 'LICENSES'), { recursive: true });
copyFileSync(licence, join(res, 'legal', 'LICENSES', 'Git.txt'));
console.error(`[fetch-git] MinGit ${GIT_VERSION} (${GIT_TAG}) staged to resources/git (sha256 ${GIT_SHA256.slice(0, 12)}...)`);
