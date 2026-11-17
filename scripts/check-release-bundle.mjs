#!/usr/bin/env node
/**
 * Release check, run at build time (after the resources are staged): fails when a file the app needs at run time
 * would not be in the installer. Each file is checked twice: it is staged under src-tauri/resources AND a glob in
 * tauri.conf.json `bundle.resources` covers it. A missing file here means the MSI would ship without it.
 *
 * Covered: Node.js with npm (fetch-node.mjs), MinGit (fetch-git.mjs), cloudflared (fetch-cloudflared.mjs), the
 * Rust MCP server (bundle-mcp.mjs builds it in release form), the relay Worker bundle, the agent adapters, and the licence texts.
 *
 * App-only updates: tauri.app-only.conf.json (the smaller installer) must NOT carry Node, Git or cloudflared and must still
 * carry everything else; the full installer carries tools-manifest.json (which says which tools version a folder holds).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GIT_MUST_KEEP, GIT_PRUNED } from './git-prune-list.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tauri = join(root, 'packages/app/src-tauri');
const res = join(tauri, 'resources');
const conf = JSON.parse(readFileSync(join(tauri, 'tauri.conf.json'), 'utf8'));
const compilePatterns = (list) => list.map((p) => {
  // A tiny glob: "**/*" is anything below, "*" is one path piece; every other character is literal.
  let re = '';
  for (let i = 0; i < p.length; ) {
    if (p.startsWith('**/*', i)) {
      re += '.*';
      i += 4;
    } else if (p[i] === '*') {
      re += '[^/]*';
      i += 1;
    } else {
      re += '[]\\^$.|?+(){}'.includes(p[i]) ? '\\' + p[i] : p[i];
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
});
// On a Mac the app is built with tauri.macos.conf.json merged over tauri.conf.json: its `bundle.resources` replaces the
// Windows list (a folder entry like "resources/pwa-dist/" covers everything below it).
const mac = process.platform === 'darwin';
const macConf = mac ? JSON.parse(readFileSync(join(tauri, 'tauri.macos.conf.json'), 'utf8')) : null;
const macEntries = mac ? Object.keys(macConf.bundle.resources).map((k) => (k.endsWith('/') ? `${k}**/*` : k)) : null;
const patterns = compilePatterns(mac ? macEntries : Array.isArray(conf.bundle.resources) ? conf.bundle.resources : Object.keys(conf.bundle.resources));
const problems = [];
const need = (rel) => {
  const path = join(tauri, rel);
  if (!existsSync(path)) problems.push(`not staged: ${rel}`);
  else if (!patterns.some((re) => re.test(rel))) problems.push(`staged but no tauri.conf.json resources glob covers it: ${rel}`);
};
const walk = (dir) =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));

const win = process.platform === 'win32';
const exe = win ? '.exe' : '';
// Node.js and npm, so nobody has to install them (fetch-node.mjs). The ACP installer runs npm from the node folder.
need(`resources/node/node${exe}`);
need(`resources/node/npm${win ? '.cmd' : ''}`);
need(`resources/node/npx${win ? '.cmd' : ''}`);
need('resources/node/node_modules/npm/package.json');
// MinGit, so nobody has to install Git on Windows (fetch-git.mjs). macOS and Linux use the system git.
if (win) need('resources/git/cmd/git.exe');
if (win) {
  // N5-5: the unused Git files stay out, and what git over HTTPS needs stays in (scripts/git-prune-list.mjs).
  for (const f of GIT_PRUNED) if (existsSync(join(res, 'git', f))) problems.push(`resources/git/${f} should have been pruned (git-prune-list.mjs)`);
  for (const f of GIT_MUST_KEEP) need(`resources/git/${f}`);
}
// cloudflared, for the phone's away-from-home tunnel (fetch-cloudflared.mjs).
need(`resources/bin/cloudflared${exe}`);
// The Rust MCP server, in release form (bundle-mcp.mjs runs build-rust-mcp.mjs, which builds --release).
// Staged for dev runs only: the installer takes the copy next to the app, so no glob covers this one (N5-5).
if (!existsSync(join(res, `bin/puppet-master-mcp${exe}`))) problems.push(`not staged: resources/bin/puppet-master-mcp${exe}`);
{
  const mcp = join(res, `bin/puppet-master-mcp${exe}`);
  if (existsSync(mcp) && statSync(mcp).size < 1024 * 1024) problems.push(`resources/bin/puppet-master-mcp${exe} is too small to be a real build`);
}
// One MCP exe in the installer: the copy next to the app (Tauri ships every cargo bin there). The resources glob must
// not take the staged `resources/bin/<mcp exe>` too (N5-5).
for (const name of ['tauri.conf.json', 'tauri.macos.conf.json']) if (readFileSync(join(tauri, name), 'utf8').includes('"resources/bin/*"')) problems.push(`${name} bundles resources/bin/* (a second copy of the MCP exe); use resources/bin/cloudflared*`);
// The tools version file: the full installer carries it, so a tools folder can say which version it is.
if (!mac) need('resources/tools-manifest.json'); // the Mac app has no tools-manifest (tools_home uses the install folder as is)
// The app-only installer config: no tools, everything else (checked below, after the staged files are known).
// The bundled bridges the app loads at run time.
need('resources/mcp-stdio.bundle.cjs');
need('resources/puppet-master-cli.bundle.mjs');
// The relay Worker that "Create team relay" uploads to the person's Cloudflare account (relay/worker/scripts/bundle-for-app.mjs).
for (const f of ['manifest.json', 'index.js', 'pm_relay_wasm_bg.wasm']) need(`resources/relay-worker/${f}`);
// The agent adapters and definitions.
if (!existsSync(join(res, 'adapters')) || walk(join(res, 'adapters')).length === 0) problems.push('no agent adapters staged under resources/adapters');
for (const f of walk(join(res, 'adapters'))) need(relative(tauri, f).split(sep).join('/'));
// The licences travel with the app.
for (const f of ['LICENSES/Node.txt', 'LICENSES/cloudflared.txt']) need(`resources/legal/${f}`);
if (win) need('resources/legal/LICENSES/Git.txt');

// App-only config (tauri.app-only.conf.json): the three tools are out, every other bundled file is still covered.
const TOOL_FILES = ['resources/node/node.exe', 'resources/node/npm.cmd', 'resources/git/cmd/git.exe', 'resources/git/usr/bin/git.exe', 'resources/bin/cloudflared.exe'];
const appOnlyPath = join(tauri, 'tauri.app-only.conf.json');
if (!existsSync(appOnlyPath)) {
  problems.push('tauri.app-only.conf.json is missing (the smaller installer for app-only updates)');
} else {
  const list = JSON.parse(readFileSync(appOnlyPath, 'utf8')).bundle?.resources ?? [];
  const small = compilePatterns(Array.isArray(list) ? list : Object.keys(list));
  for (const f of TOOL_FILES) if (small.some((re) => re.test(f))) problems.push(`tauri.app-only.conf.json would still bundle ${f}`);
  if (small.some((re) => re.test('resources/tools-manifest.json'))) problems.push('tauri.app-only.conf.json must not bundle tools-manifest.json (only the full installer says it holds the tools)');
  // Everything the full installer carries except the three tool folders, the manifest and the cloudflared glob stays.
  for (const entry of Array.isArray(conf.bundle.resources) ? conf.bundle.resources : Object.keys(conf.bundle.resources)) {
    const isTool = entry.startsWith('resources/node/') || entry.startsWith('resources/git/') || entry.startsWith('resources/bin/cloudflared') || entry === 'resources/tools-manifest.json';
    if (!isTool && !(Array.isArray(list) ? list : Object.keys(list)).includes(entry)) problems.push(`tauri.app-only.conf.json lost the resource entry ${entry}`);
  }
}

if (problems.length) {
  console.error('[check-release-bundle] the installer would be missing files:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.error('[check-release-bundle] ok: every file the app needs is staged and covered by tauri.conf.json');
