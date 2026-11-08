import { describe, expect, it } from 'vitest';
import { diffHunks, diffStats, patchText, type DiffLine } from './chatDiff';

describe('diff card helpers', () => {
  const lines: DiffLine[] = [
    { op: 'head', text: '@@ one' },
    { op: 'same', text: 'a' },
    { op: 'del', text: 'b' },
    { op: 'add', text: 'B' },
    { op: 'add', text: 'C' },
    { op: 'head', text: '@@ two' },
    { op: 'same', text: 'z' },
  ];

  it('counts added and removed lines', () => {
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
  });

  it('splits at each header, and keeps lines before the first header in a hunk of their own', () => {
    expect(diffHunks(lines).map((hunk) => [hunk.head, hunk.lines.length])).toEqual([
      ['@@ one', 4],
      ['@@ two', 1],
    ]);
    expect(diffHunks([{ op: 'add', text: 'x' }])).toEqual([{ head: null, lines: [{ op: 'add', text: 'x' }] }]);
  });

  it('writes patch text with a prefix per line, and file lines when the path is known', () => {
    expect(patchText(lines.slice(1, 4))).toBe(' a\n-b\n+B');
    expect(patchText([{ op: 'add', text: 'x' }], 'src/a.ts')).toBe('--- src/a.ts\n+++ src/a.ts\n+x');
  });
});
