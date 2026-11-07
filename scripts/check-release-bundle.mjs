#!/usr/bin/env node
/**
 * Release check, run at build time (after the resources are staged): fails when a file the app needs at run time
 * would not be in the installer. Each file is checked twice: it is staged under src-tauri/resources AND a glob in
 * tauri.conf.json `bundle.resources` covers it. A missing file here means the MSI would ship without it.
 *
 * Covered: Node.js with npm (fetch-node.mjs), MinGit (fetch-git.mjs), cloudflared (fetch-cloudflared.mjs), the
 * Rust MCP server (bundle-mcp.mjs builds it in release form), the agent adapters, and the licence texts.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tauri = join(root, 'packages/app/src-tauri');
const res = join(tauri, 'resources');
const conf = JSON.parse(readFileSync(join(tauri, 'tauri.conf.json'), 'utf8'));
const patterns = (Array.isArray(conf.bundle.resources) ? conf.bundle.resources : Object.keys(conf.bundle.resources)).map((p) => {
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
// cloudflared, for the phone's away-from-home tunnel (fetch-cloudflared.mjs).
need(`resources/bin/cloudflared${exe}`);
// The Rust MCP server, in release form (bundle-mcp.mjs runs build-rust-mcp.mjs, which builds --release).
need(`resources/bin/puppet-master-mcp${exe}`);
{
  const mcp = join(res, `bin/puppet-master-mcp${exe}`);
  if (existsSync(mcp) && statSync(mcp).size < 1024 * 1024) problems.push(`resources/bin/puppet-master-mcp${exe} is too small to be a real build`);
}
// The bundled bridges the app loads at run time.
need('resources/mcp-stdio.bundle.cjs');
need('resources/puppet-master-cli.bundle.mjs');
// The agent adapters and definitions.
if (!existsSync(join(res, 'adapters')) || walk(join(res, 'adapters')).length === 0) problems.push('no agent adapters staged under resources/adapters');
for (const f of walk(join(res, 'adapters'))) need(relative(tauri, f).split(sep).join('/'));
// The licences travel with the app.
for (const f of ['LICENSES/Node.txt', 'LICENSES/cloudflared.txt']) need(`resources/legal/${f}`);
if (win) need('resources/legal/LICENSES/Git.txt');

if (problems.length) {
  console.error('[check-release-bundle] the installer would be missing files:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.error('[check-release-bundle] ok: every file the app needs is staged and covered by tauri.conf.json');
