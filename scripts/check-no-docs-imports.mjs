#!/usr/bin/env node
// Guard: nothing under packages/ may import, include or require a file in the repo's top-level `docs/` folder.
// The public export of this repo leaves `docs/` out, so such a reference builds here and breaks there.
//
// Checked: JS/TS `import ... from`, `export ... from`, `import '...'`, `import(...)`, `require(...)`, and Rust
// `include_str!`, `include_bytes!`, `include!` and `#[path = ...]`. A relative path is resolved from the file's
// folder; it is a violation when it lands in a top-level `docs/` folder. A `docs/` folder inside packages/ is fine.
//
//   node scripts/check-no-docs-imports.mjs
//
// Run by `scripts/check.mjs`. Exit code 1 and one line per problem when something is found.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exts = /\.(ts|tsx|js|mjs|cjs|rs)$/;

// Groups: 2 = from-spec, 4 = import()/require() spec, 6 = bare `import 'spec'`.
const JS_REF =
  /\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"`])([^'"`\n]+)\1|\b(?:import|require)\s*\(\s*(['"`])([^'"`\n]+)\3|\bimport\s+(['"`])([^'"`\n]+)\5/g;
// Groups: 1 = include*!("x"), 2 = #[path = "x"].
const RS_REF = /\binclude(?:_str|_bytes)?!\s*\(\s*"([^"\n]+)"|#\[path\s*=\s*"([^"\n]+)"\]/g;

const files = execFileSync('git', ['ls-files', '-z', '--', 'packages'], { cwd: root, maxBuffer: 1 << 28 })
  .toString('utf8')
  .split('\0')
  .filter((f) => f && exts.test(f));

const problems = [];

// A relative spec, resolved from the file's folder, that lands in a top-level docs/ folder.
function check(file, spec, index, text) {
  if (!spec) return;
  const clean = spec.split('?')[0];
  if (!(clean.startsWith('./') || clean.startsWith('../'))) return;
  const target = posix.normalize(posix.join(posix.dirname(file), clean));
  if (target.startsWith('../')) return; // leaves the repo, so it is not this repo's docs/ folder
  if (target.split('/')[0] !== 'docs') return;
  const line = text.slice(0, index).split('\n').length;
  problems.push(`${file}:${line}  "${spec}"  ->  ${target}`);
}

for (const file of files) {
  let text;
  try {
    text = readFileSync(resolve(root, file), 'utf8');
  } catch {
    continue; // deleted in the working tree
  }
  if (text.slice(0, 8192).includes('\0')) continue; // binary

  for (const m of text.matchAll(JS_REF)) check(file, m[2] ?? m[4] ?? m[6], m.index, text);
  for (const m of text.matchAll(RS_REF)) check(file, m[1] ?? m[2], m.index, text);
}

if (problems.length === 0) {
  console.log(`[docs-imports] clean: no package file reaches a top-level docs/ folder (${files.length} files).`);
  process.exit(0);
}

console.error(`[docs-imports] ${problems.length} problem(s): packages/ must not read docs/ (the public export leaves it out).`);
for (const p of problems) console.error(`  ${p}`);
console.error('\nMove the file under packages/ (next to the code that reads it) and leave a pointer stub in docs/.');
process.exit(1);
