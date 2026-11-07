#!/usr/bin/env node
/**
 * Release build step: puts the official cloudflared inside the app, so the phone's "away from home"
 * tunnel works without the person installing anything.
 *
 *   Windows: cloudflared-windows-amd64.exe  -> resources/bin/cloudflared.exe
 *   macOS:   cloudflared-darwin-<arch>.tgz  -> resources/bin/cloudflared
 *
 * Each download is checked against the pinned sha256 below, cached outside the repo
 * (%LOCALAPPDATA%\potato-workspace-build-cache, or PM_BUILD_CACHE), and its Apache-2.0 licence text
 * is staged to resources/legal/LICENSES/cloudflared.txt.
 *
 * Version and hashes are pinned here: change them together, on purpose, never by accident.
 * The hashes came from the `digest` field GitHub shows for these release assets
 * (GET https://api.github.com/repos/cloudflare/cloudflared/releases/tags/2026.10.7), read on
 * 2026-11-07 and then confirmed by hashing the downloads.
 * cloudflared publishes no NOTICE file at this tag; its LICENSE (Apache-2.0) is the only licence file in the repo root.
 * PM_SKIP_CLOUDFLARED=1 skips the step for a build that is not for release.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CLOUDFLARED_VERSION = '2026.10.7';
const CLOUDFLARED_WIN_SHA256 = '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343';
const CLOUDFLARED_DARWIN_X64_SHA256 = '02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848';
const CLOUDFLARED_DARWIN_ARM64_SHA256 = '3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const res = join(root, 'packages/app/src-tauri/resources');

if (process.env.PM_SKIP_CLOUDFLARED === '1') {
  console.error('[fetch-cloudflared] PM_SKIP_CLOUDFLARED=1: skipped');
  process.exit(0);
}

function cloudflaredAsset() {
  if (process.platform === 'win32') {
    return { name: 'cloudflared-windows-amd64.exe', sha256: CLOUDFLARED_WIN_SHA256, kind: 'exe', staged: 'cloudflared.exe' };
  }
  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    return {
      name: `cloudflared-darwin-${arch}.tgz`,
      sha256: arch === 'arm64' ? CLOUDFLARED_DARWIN_ARM64_SHA256 : CLOUDFLARED_DARWIN_X64_SHA256,
      kind: 'tgz',
      staged: 'cloudflared',
    };
  }
  throw new Error(`[fetch-cloudflared] unsupported platform ${process.platform}; add its pinned release asset here`);
}

const asset = cloudflaredAsset();
const cacheRoot = process.env.PM_BUILD_CACHE || join(process.env.LOCALAPPDATA || join(homedir(), '.cache'), 'potato-workspace-build-cache');
const cache = join(cacheRoot, `cloudflared-${CLOUDFLARED_VERSION}-${process.platform}-${process.arch}`);
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

mkdirSync(cache, { recursive: true });
const download = join(cache, asset.name);
if (!existsSync(download) || sha(download) !== asset.sha256) {
  console.error(`[fetch-cloudflared] downloading ${asset.name} ${CLOUDFLARED_VERSION}`);
  writeFileSync(`${download}.part`, await get(`https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.name}`));
  const got = sha(`${download}.part`);
  if (got !== asset.sha256) {
    rmSync(`${download}.part`, { force: true });
    throw new Error(`${asset.name}: sha256 ${got} does not match the pinned ${asset.sha256}; refusing to stage it`);
  }
  renameSync(`${download}.part`, download);
}

let binary;
if (asset.kind === 'exe') {
  binary = download;
} else {
  const unpacked = join(cache, 'unpacked');
  binary = join(unpacked, 'cloudflared');
  if (!existsSync(binary)) {
    rmSync(unpacked, { recursive: true, force: true });
    mkdirSync(unpacked, { recursive: true });
    const r = spawnSync('tar', ['-xzf', download, '-C', unpacked], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`could not unpack ${asset.name}`);
  }
  if (!existsSync(binary)) throw new Error(`${asset.name} has no cloudflared binary`);
}

const licence = join(cache, 'LICENSE');
if (!existsSync(licence)) {
  const text = await get(`https://raw.githubusercontent.com/cloudflare/cloudflared/${CLOUDFLARED_VERSION}/LICENSE`);
  if (!text.toString('utf8').includes('Apache License')) throw new Error('the cloudflared LICENSE is not the Apache-2.0 text');
  writeFileSync(licence, text);
}

mkdirSync(join(res, 'bin'), { recursive: true });
const staged = join(res, 'bin', asset.staged);
copyFileSync(binary, staged);
if (process.platform !== 'win32') chmodSync(staged, 0o755);
mkdirSync(join(res, 'legal', 'LICENSES'), { recursive: true });
copyFileSync(licence, join(res, 'legal', 'LICENSES', 'cloudflared.txt'));
console.error(
  `[fetch-cloudflared] cloudflared ${CLOUDFLARED_VERSION} ${process.platform}-${process.arch} staged (sha256 ${asset.sha256.slice(0, 12)}...)`,
);
