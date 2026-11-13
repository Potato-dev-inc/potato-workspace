// A new hard-coded English string in a screen file that already moved to translation keys fails here.
// A line may opt out with a trailing `// i18n-ok: why` (a brand name, a code sample).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOVED_FILES } from './moved-files';

const SRC = join(__dirname, '..');
const ATTR = /\b(?:aria-label|title|placeholder|alt|label|description|hint|heading|subtitle)=("([^"{}]*[A-Za-z]{2,}[^"{}]*)"|\{'([^'{}]*[A-Za-z]{2,}[^'{}]*)'\}|\{`([^`${}]*[A-Za-z]{2,}[^`${}]*)`\})/;
const TEXT = />\s*([^<>{}\n]*[A-Za-z]{2,}[^<>{}\n]*)\s*<\//;
const TEXT_LINE = /^\s*([A-Z][A-Za-z'’,.!?:;()\-/ ]*[a-z]{2,}[A-Za-z'’,.!?:;()\-/ ]*)$/;

/** Hard-coded English found in a file's JSX, as "line: text". */
export function hardCodedEnglish(source: string): string[] {
  const out: string[] = [];
  let inJsxBlock = false;
  source.split('\n').forEach((line, i) => {
    if (line.includes('i18n-ok')) return;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    const attr = ATTR.exec(line);
    if (attr) out.push(`${i + 1}: ${attr[2] ?? attr[3] ?? attr[4]}`);
    const text = TEXT.exec(line);
    if (text && !/^\s*\{/.test(text[1]) && /[A-Za-z]{2,}/.test(text[1].replace(/&\w+;/g, ''))) out.push(`${i + 1}: ${text[1].trim()}`);
    // A line of plain words between a tag's `>` and the closing tag on a later line.
    if (inJsxBlock && TEXT_LINE.test(line) && !/[=;{}]|=>/.test(line)) out.push(`${i + 1}: ${trimmed}`);
    inJsxBlock = /^\s*<[A-Za-z][^>]*>\s*$/.test(line) || (inJsxBlock && TEXT_LINE.test(line));
  });
  return out;
}

describe('moved files have no hard-coded English in their JSX', () => {
  it('the scanner itself finds the strings it should', () => {
    expect(hardCodedEnglish('<button>Save it</button>')).toHaveLength(1);
    expect(hardCodedEnglish('<input placeholder="Search" />')).toHaveLength(1);
    expect(hardCodedEnglish('<button>{t("a.b")}</button>')).toHaveLength(0);
    expect(hardCodedEnglish('<code>x</code> // i18n-ok')).toHaveLength(0);
    expect(hardCodedEnglish('<b>\n  Hello there\n</b>')).toHaveLength(1);
  });

  for (const file of MOVED_FILES) {
    it(`${file}`, () => {
      const found = hardCodedEnglish(readFileSync(join(SRC, file), 'utf8'));
      expect(found, `move these to src/i18n (or mark the line // i18n-ok):\n${found.join('\n')}`).toEqual([]);
    });
  }
});
