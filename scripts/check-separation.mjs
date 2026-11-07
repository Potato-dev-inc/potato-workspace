#!/usr/bin/env node
// Guard: Potato Workspace must not use the other product's names for its own paths, ports,
// tool-server key or skills. Deliberate mentions (the legacy folder name used only to copy old
// data, the kept crate/binary names, the checkpoint env scrub list) are allowed.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scanRoots = ['packages/app/src-tauri/src', 'packages/app/src', 'packages/shared/src', 'packages/cli/src', 'packages/mcp-server/src'];

const banned = [
  // A production path or env var belonging to the other product.
  [/\.puppet-master\b/, 'path folder `.puppet-master`'],
  [/\bPUPPET_MASTER_[A-Z_]+/, 'environment variable `PUPPET_MASTER_*`'],
  [/@puppet-master\//, 'package scope `@puppet-master/`'],
  [/puppet-master:\/\//, 'resource URI `puppet-master://`'],
  // Our own tool-server key must never be the other product's name.
  [/mcpServers\.puppet-master\b/, 'agent config key `mcpServers.puppet-master`'],
  [/mcp_servers\.puppet-master\b/, 'agent config key `mcp_servers.puppet-master`'],
  [/mcp\.puppet-master\b/, 'agent config key `mcp.puppet-master`'],
  [/["'`]puppet-master["'`]/, 'tool-server key `puppet-master`'],
  // Our own port range must stay away from the other product's 17321..17399.
  [/\(17321,\s*17399\)/, 'bridge port range 17321..17399'],
  [/17321\.\.=17330/, 'shim probe range 17321..=17330'],
];

// These lines are deliberate and safe: they only recognise/never write the old names, or keep
// the existing crate/binary names (a later, separate rename).
const allow = [
  /LEGACY_PROJECT_DIR_NAME|LEGACY_HOME_DIR_NAME|LEGACY_COMPANION_HOME_DIR_NAME/,
  /ALWAYS_DROP|"GIT_",\s*"POTATO_WORKSPACE",\s*"PM_"/,
  /puppet-master-mcp|puppet-master-cli|puppet-master-orchestrator/,
  /puppet_master_app_lib|puppet_master_app\b/,
];

const exts = new Set(['.rs', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.toml', '.json']);

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'target' || name === 'dist' || name.endsWith('.bundle.cjs') || name.endsWith('.bundle.mjs')) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...walk(path));
    else if (exts.has(name.slice(name.lastIndexOf('.')))) out.push(path);
  }
  return out;
}

const problems = [];
for (const rel of scanRoots) {
  for (const file of walk(join(root, rel))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (allow.some((re) => re.test(line))) return;
      for (const [re, what] of banned) {
        if (re.test(line)) problems.push(`${relative(root, file)}:${i + 1}: ${what}\n    ${line.trim().slice(0, 160)}`);
      }
    });
  }
}

// The skill pack must be named for this product.
const skills = join(root, 'integrations', 'skills');
if (existsSync(skills) && readdirSync(skills).some((n) => /puppet/i.test(n))) {
  problems.push(`integrations/skills still has a puppet-named skill`);
}

if (problems.length) {
  console.error(`[separation] ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('[separation] clean: no other-product paths, ports, tool key or skill names.');
