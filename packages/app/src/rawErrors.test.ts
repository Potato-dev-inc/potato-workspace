// Guard: screens must not show a caught value's own text (`e.message`, `String(e)`). Use `sayError` /
// `errorSentence` from lib/sayError.ts. Files that still do are listed in rawErrors.pending.json with how many
// places each has. The list may only SHRINK: a new file or a higher count fails, and so does a count that is
// too high (lower it). Regenerate after converting sites with: UPDATE_RAW_ERRORS=1 npx vitest run src/rawErrors.test.ts
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = __dirname;
const PENDING = join(SRC, 'rawErrors.pending.json');

/** Files that are allowed to read the raw value: they are the helpers and loggers themselves. */
const EXEMPT = new Set(['lib/sayError.ts', 'lib/globalErrors.ts', 'components/common/ErrorBoundary.tsx']);

/** A caught value's own text: `x instanceof Error ? x.message`, `String(e)`, `e.message`. */
const PATTERNS: RegExp[] = [/instanceof Error \? \w+\.message/g, /\bString\((?:e|err|error|ex|cause|reason)\)/g, /\b(?:e|err|error|ex)\.message\b/g];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dev') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

export function countRawErrors(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).split(sep).join('/');
    if (EXEMPT.has(rel)) continue;
    const text = readFileSync(file, 'utf8');
    // One site can match two patterns (`e instanceof Error ? e.message`), so count lines, not matches.
    const lines = text.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && PATTERNS.some((re) => new RegExp(re.source).test(line)));
    if (lines.length) counts[rel] = lines.length;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

describe('raw error text in screens', () => {
  const actual = countRawErrors();

  if (process.env.UPDATE_RAW_ERRORS === '1') {
    writeFileSync(PENDING, `${JSON.stringify(actual, null, 2)}\n`);
  }
  const pending = JSON.parse(readFileSync(PENDING, 'utf8')) as Record<string, number>;

  it('has no new file that shows e.message or String(e)', () => {
    const fresh = Object.keys(actual).filter((f) => !(f in pending));
    expect(fresh, `Use sayError (lib/sayError.ts) instead of e.message / String(e) in: ${fresh.join(', ')}`).toEqual([]);
  });

  it('has no file with more raw sites than the pending list allows', () => {
    const worse = Object.entries(actual).filter(([f, n]) => f in pending && n > pending[f]);
    expect(worse, 'More raw error sites than before. Use sayError.').toEqual([]);
  });

  it('keeps the pending list honest: converted files and lower counts must be removed from it', () => {
    const stale = Object.entries(pending).filter(([f, n]) => (actual[f] ?? 0) < n);
    expect(stale.map(([f]) => f), 'Regenerate with UPDATE_RAW_ERRORS=1 so the list shrinks.').toEqual([]);
  });
});
