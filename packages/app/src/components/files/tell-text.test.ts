import { describe, expect, it } from 'vitest';
import { tellText } from './tell-text';

describe('tellText', () => {
  it('quotes the lines and puts the note after them', () => {
    expect(tellText('src/a.ts', 3, 4, 'x\ny\n', ' Why this? ')).toBe('`src/a.ts` lines 3-4:\n```\nx\ny\n```\nWhy this?');
  });
  it('says "line" for one line and leaves room to type when there is no note', () => {
    expect(tellText('a.md', 7, 7, 'z', '', 'diff')).toBe('`a.md` line 7:\n```diff\nz\n```\n');
  });
});
