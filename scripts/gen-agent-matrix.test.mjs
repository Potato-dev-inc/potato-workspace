// Tests for scripts/gen-agent-matrix.mjs. Run with:
//   node --test scripts/gen-agent-matrix.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { cellText, main, render } from './gen-agent-matrix.mjs';

const MATRIX = {
  schema: 1,
  vectors: [
    { id: 'B01', title: 'Handshake', claims: ['chat'], cells: { native: { result: 'pass', mark: 'fake' }, terminal_only: { result: 'not_claimed', mark: 'fake' } } },
    { id: 'B02', title: 'Streams | text', claims: [], cells: { native: { result: 'pass', mark: 'real', date: '2026-11-13', version: '1.2.0' }, terminal_only: { result: 'fail', mark: 'fake', why: 'no text' } } },
  ],
  notes: [{ target: 'json', note: 'not on this branch' }],
};

const dirs = [];
function temp() {
  const d = mkdtempSync(join(tmpdir(), 'agent-matrix-'));
  dirs.push(d);
  return d;
}
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('render', () => {
  it('has one row per agent kind and one column per behaviour', () => {
    const doc = render(MATRIX);
    assert.match(doc, /\| Agent kind \| B01 \| B02 \|/);
    assert.match(doc, /Chat agent that keeps the rules \(`native`\) \| pass \(fake\) \| pass \(real 2026-11-13 1\.2\.0\) \|/);
    assert.match(doc, /\(`terminal_only`\) \| - \| FAIL \(fake\) \|/);
  });
  it('escapes a pipe and lists why a cell fails and what was not run', () => {
    const doc = render(MATRIX);
    assert.match(doc, /Streams \\\| text/);
    assert.match(doc, /B02 on `terminal_only`: no text/);
    assert.match(doc, /`json`: not on this branch/);
  });
  it('shows a not-claimed cell as a dash', () => assert.equal(cellText({ result: 'not_claimed', mark: 'fake' }), '-'));
});

describe('main', () => {
  it('writes the doc, then sees it fresh, then sees it stale when the JSON changes', (t) => {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    const dir = temp();
    const json = join(dir, 'm.json');
    const out = join(dir, 'AGENT-MATRIX.md');
    writeFileSync(json, JSON.stringify(MATRIX));
    assert.equal(main(['--json', json, '--out', out, '--check']), 1, 'a missing doc is stale');
    assert.equal(main(['--json', json, '--out', out]), 0);
    assert.equal(readFileSync(out, 'utf8'), render(MATRIX));
    assert.equal(main(['--json', json, '--out', out, '--check']), 0);
    writeFileSync(json, JSON.stringify({ ...MATRIX, notes: [] }));
    assert.equal(main(['--json', json, '--out', out, '--check']), 1, 'a changed JSON makes the doc stale');
  });
});
