#!/usr/bin/env node
/**
 * Builds the relay Worker into the files the desktop app uploads to a person's own Cloudflare account
 * ("Create team relay" in Settings > Team; packages/app/src-tauri/src/team/relay_deploy.rs). No wrangler and
 * no Node on the person's computer: the app sends these through the Cloudflare API itself.
 *
 * Out (default packages/app/src-tauri/resources/relay-worker/, or the folder given as the first argument):
 *   index.js               one ES module: src/index.ts and everything it imports, the viewer files inlined as text
 *   pm_relay_wasm_bg.wasm  the protocol checks, uploaded as its own module (the JS imports it by this name)
 *   manifest.json          what the upload needs from wrangler.toml: name, main module, modules and their
 *                          content types, compatibility date, Durable Object bindings, migrations, observability
 *
 * Uses esbuild (a devDependency of the repo root, already used by scripts/bundle-mcp.mjs). wrangler.toml stays the
 * one source of truth: anything in it this script does not understand stops the build, so the app never uploads a
 * relay that differs from `npm run deploy`.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const worker = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(worker, '../../packages/app/src-tauri/resources/relay-worker'));
const WASM = 'pm_relay_wasm_bg.wasm';
const MAIN = 'index.js';

/** The small part of TOML wrangler.toml uses: tables, arrays of tables, strings, booleans and string arrays. */
export function readWranglerToml(text) {
  const top = {};
  const tables = { 'durable_objects.bindings': [], migrations: [], rules: [] };
  let current = top;
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    let m;
    if ((m = line.match(/^\[\[([\w.]+)\]\]$/))) {
      section = m[1];
      if (!(section in tables)) throw new Error(`wrangler.toml: [[${section}]] is not supported by the app's relay upload`);
      current = {};
      tables[section].push(current);
    } else if ((m = line.match(/^\[([\w.]+)\]$/))) {
      section = m[1];
      if (section !== 'observability') throw new Error(`wrangler.toml: [${section}] is not supported by the app's relay upload`);
      current = top.observability = {};
    } else if ((m = line.match(/^(\w+)\s*=\s*(.+)$/))) {
      current[m[1]] = JSON.parse(m[2]);
    } else {
      throw new Error(`wrangler.toml: can't read this line: ${raw}`);
    }
  }
  const known = new Set(['name', 'main', 'compatibility_date', 'observability']);
  for (const key of Object.keys(top)) if (!known.has(key)) throw new Error(`wrangler.toml: "${key}" is not supported by the app's relay upload`);
  for (const mig of tables.migrations) {
    for (const key of Object.keys(mig)) {
      if (key !== 'tag' && key !== 'new_sqlite_classes') throw new Error(`wrangler.toml: migration "${key}" is not supported by the app's relay upload`);
    }
  }
  return { ...top, bindings: tables['durable_objects.bindings'], migrations: tables.migrations };
}

export function manifestFrom(toml) {
  return {
    format: 1,
    name: toml.name,
    main_module: MAIN,
    compatibility_date: toml.compatibility_date,
    modules: [
      { name: MAIN, file: MAIN, content_type: 'application/javascript+module' },
      { name: WASM, file: WASM, content_type: 'application/wasm' },
    ],
    bindings: toml.bindings.map((b) => ({ type: 'durable_object_namespace', name: b.name, class_name: b.class_name })),
    migrations: toml.migrations.map((m) => ({ tag: m.tag, new_sqlite_classes: m.new_sqlite_classes ?? [] })),
    observability: toml.observability?.enabled === true,
  };
}

/** `.wasm` imports stay imports of the uploaded wasm module; the viewer files become strings (wrangler's Text rule). */
const workerModules = {
  name: 'worker-modules',
  setup(build) {
    build.onResolve({ filter: /\.wasm$/ }, (args) => {
      if (basename(args.path) !== WASM) throw new Error(`unexpected wasm import ${args.path}`);
      return { path: `./${WASM}`, external: true };
    });
    build.onLoad({ filter: /[\\/]viewer\.(html|js|css)$/ }, (args) => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }));
  },
};

async function main() {
  const toml = readWranglerToml(readFileSync(join(worker, 'wrangler.toml'), 'utf8'));
  if (toml.main !== 'src/index.ts') throw new Error(`wrangler.toml: main is ${toml.main}, expected src/index.ts`);
  mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [join(worker, toml.main)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    conditions: ['workerd', 'worker', 'browser'],
    external: ['cloudflare:*'],
    plugins: [workerModules],
    outfile: join(out, MAIN),
    logLevel: 'warning',
  });
  copyFileSync(join(worker, 'src/wasm', WASM), join(out, WASM));
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifestFrom(toml), null, 2)}\n`);
  console.error(`[relay bundle] wrote ${out}`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[relay bundle] ${err.message ?? err}`);
    process.exit(1);
  });
}
