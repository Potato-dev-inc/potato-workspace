import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import esbuild from 'esbuild';

const root = resolve(import.meta.dirname, '..', '..', '..');

test('the standalone CLI bundle prints the real version, not 0.0.0', async () => {
  const { cliBundleOptions } = await import(pathToFileURL(resolve(root, 'scripts/cli-bundle-options.mjs')).href);
  const dir = mkdtempSync(join(tmpdir(), 'cli-bundle-'));
  try {
    const outfile = join(dir, 'cli.bundle.mjs');
    await esbuild.build({ ...cliBundleOptions(root, outfile), logLevel: 'silent' });
    const expected = JSON.parse(readFileSync(resolve(root, 'packages/cli/package.json'), 'utf-8')).version;
    const run = spawnSync(process.execPath, [outfile, 'version'], { encoding: 'utf-8', cwd: dir });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), expected);
    assert.notEqual(run.stdout.trim(), '0.0.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
