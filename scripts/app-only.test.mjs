// Tests for the app-only update scripts. Run with:
//   node --test scripts/app-only.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { APP_ONLY_MIN_FROM, buildLatest } from './make-latest-json.mjs';
import { COUNTED_FOLDERS, HASHED_FILES, differences, pinnedVersions } from './make-tools-manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const LATEST = join(here, 'make-latest-json.mjs');
const TOOLS = join(here, 'make-tools-manifest.mjs');
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'latest-1.1.1.json'), 'utf8'));
const tmp = () => mkdtempSync(join(tmpdir(), 'app-only-test-'));
const run = (script, args, env = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

/** A fake repo root (conf, changelog, manifest) plus a full MSI folder and an app-only folder with signatures. */
function fakeRelease({ version = '1.2.1', appOnlyVersion = version, fullBytes = 5000, appBytes = 1000 } = {}) {
  const root = tmp();
  mkdirSync(join(root, 'packages/app/src-tauri/resources'), { recursive: true });
  writeFileSync(join(root, 'packages/app/src-tauri/tauri.conf.json'), JSON.stringify({ version }));
  writeFileSync(join(root, 'packages/app/src-tauri/resources/tools-manifest.json'), JSON.stringify({ toolsVersion: 3 }));
  writeFileSync(join(root, 'CHANGELOG.md'), `## ${version}\n- a thing\n\n## 1.0.0\n- old\n`);
  const full = join(root, 'full');
  const app = join(root, 'app');
  mkdirSync(full);
  mkdirSync(app);
  writeFileSync(join(full, `Potato Workspace_${version}_x64_en-US.msi`), 'F'.repeat(fullBytes));
  writeFileSync(join(full, `Potato Workspace_${version}_x64_en-US.msi.sig`), 'FULL-SIGNATURE\n');
  writeFileSync(join(app, `Potato Workspace_${appOnlyVersion}_x64_en-US.msi`), 'A'.repeat(appBytes));
  writeFileSync(join(app, `Potato Workspace_${appOnlyVersion}_x64_en-US.msi.sig`), 'APP-SIGNATURE\n');
  return { root, full, app, out: join(root, 'out') };
}

describe('make-latest-json', () => {
  it('without an app-only package writes exactly the one-platform file of 1.1.1', () => {
    const rebuilt = buildLatest({
      version: fixture.version,
      notes: fixture.notes,
      pubDate: fixture.pub_date,
      signature: fixture.platforms['windows-x86_64'].signature,
      asset: 'Potato-Workspace_1.1.1_x64_en-US.msi',
      appOnly: null,
    });
    assert.deepEqual(rebuilt, fixture);
    assert.deepEqual(Object.keys(rebuilt), ['version', 'notes', 'pub_date', 'platforms']);
  });

  it('the command line without the third argument also writes only the full platform', () => {
    const r = fakeRelease();
    const res = run(LATEST, [r.full, r.out], { PM_LATEST_ROOT: r.root });
    assert.equal(res.status, 0, res.stderr);
    const latest = JSON.parse(readFileSync(join(r.out, 'latest.json'), 'utf8'));
    assert.deepEqual(Object.keys(latest.platforms), ['windows-x86_64']);
    assert.equal(latest.potato, undefined);
    assert.equal(latest.platforms['windows-x86_64'].signature, 'FULL-SIGNATURE');
    assert.ok(!existsSync(join(r.out, 'Potato-Workspace_1.2.1_x64_app-only-update.msi')));
  });

  it('with the third argument both platforms carry their own signature and potato.appOnly is filled', () => {
    const r = fakeRelease();
    const res = run(LATEST, [r.full, r.out, r.app], { PM_LATEST_ROOT: r.root });
    assert.equal(res.status, 0, res.stderr);
    const latest = JSON.parse(readFileSync(join(r.out, 'latest.json'), 'utf8'));
    assert.deepEqual(Object.keys(latest.platforms).sort(), ['windows-x86_64', 'windows-x86_64-app']);
    assert.equal(latest.platforms['windows-x86_64'].signature, 'FULL-SIGNATURE');
    assert.equal(latest.platforms['windows-x86_64-app'].signature, 'APP-SIGNATURE');
    assert.ok(latest.platforms['windows-x86_64'].url.endsWith('/v1.2.1/Potato-Workspace_1.2.1_x64_en-US.msi'));
    assert.ok(latest.platforms['windows-x86_64-app'].url.endsWith('/v1.2.1/Potato-Workspace_1.2.1_x64_app-only-update.msi'));
    assert.deepEqual(latest.potato, { appOnly: { toolsVersion: 3, size: 1000, fullSize: 5000, minFrom: APP_ONLY_MIN_FROM } });
    assert.equal(readFileSync(join(r.out, 'Potato-Workspace_1.2.1_x64_app-only-update.msi'), 'utf8'), 'A'.repeat(1000));
  });

  it('exits 1 when the two MSIs are for different versions', () => {
    const r = fakeRelease({ appOnlyVersion: '1.2.0' });
    const res = run(LATEST, [r.full, r.out, r.app], { PM_LATEST_ROOT: r.root });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /1\.2\.0.*1\.2\.1/);
    assert.ok(!existsSync(join(r.out, 'latest.json')), 'no mixed file is written');
  });

  it('exits 1 when the app-only MSI is not smaller', () => {
    const r = fakeRelease({ fullBytes: 1000, appBytes: 1000 });
    const res = run(LATEST, [r.full, r.out, r.app], { PM_LATEST_ROOT: r.root });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not smaller/);
  });
});

describe('make-tools-manifest', () => {
  const versions = pinnedVersions();
  const base = { toolsVersion: 1, ...versions, counts: { node: 2, git: 1 }, files: [{ path: 'node/node.exe', size: 3, sha256: 'aa' }] };
  const measured = { files: [{ path: 'node/node.exe', size: 3, sha256: 'aa' }], counts: { node: 2, git: 1 } };

  it('a matching manifest has no differences', () => {
    assert.deepEqual(differences(base, versions, measured), []);
  });

  it('a new pinned version, a changed file or a different file count is a difference', () => {
    assert.equal(differences(base, { ...versions, node: '99.0.0' }, measured).length, 1);
    assert.equal(differences(base, versions, { ...measured, files: [{ path: 'node/node.exe', size: 3, sha256: 'bb' }] }).length, 1);
    assert.equal(differences(base, versions, { ...measured, counts: { node: 3, git: 1 } }).length, 1);
  });

  /** Fake staged tools: every hashed file and the folders to count. */
  function stagedTools(content) {
    const res = tmp();
    for (const rel of HASHED_FILES) {
      mkdirSync(dirname(join(res, rel)), { recursive: true });
      writeFileSync(join(res, rel), `${content}:${rel}`);
    }
    for (const f of COUNTED_FOLDERS) mkdirSync(join(res, f), { recursive: true });
    return res;
  }

  it('--check fails when a tool changed but toolsVersion did not, and passes after --bump', () => {
    const manifest = join(tmp(), 'tools-manifest.json');
    const v1 = stagedTools('one');
    let res = run(TOOLS, ['--resources', v1], { PM_TOOLS_MANIFEST: manifest });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).toolsVersion, 1);
    res = run(TOOLS, ['--check', '--resources', v1], { PM_TOOLS_MANIFEST: manifest });
    assert.equal(res.status, 0, res.stderr);

    // A different node.exe with the same number: the check fails and a plain write refuses.
    const v2 = stagedTools('two');
    res = run(TOOLS, ['--check', '--resources', v2], { PM_TOOLS_MANIFEST: manifest });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /toolsVersion is still 1/);
    res = run(TOOLS, ['--resources', v2], { PM_TOOLS_MANIFEST: manifest });
    assert.equal(res.status, 1);
    assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).toolsVersion, 1, 'nothing was rewritten');

    // --bump raises the number by one and the check passes again.
    res = run(TOOLS, ['--bump', '--resources', v2], { PM_TOOLS_MANIFEST: manifest });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).toolsVersion, 2);
    res = run(TOOLS, ['--check', '--resources', v2], { PM_TOOLS_MANIFEST: manifest });
    assert.equal(res.status, 0, res.stderr);
  });

  it('the committed manifest names the versions the fetch scripts pin', () => {
    const committed = JSON.parse(readFileSync(join(here, '../packages/app/src-tauri/resources/tools-manifest.json'), 'utf8'));
    assert.deepEqual(differences(committed, pinnedVersions(), null), []);
    assert.ok(Number.isInteger(committed.toolsVersion) && committed.toolsVersion >= 1);
  });
});
