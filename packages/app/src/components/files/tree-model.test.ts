import { describe, expect, it } from 'vitest';
import { fileMark, folderHasChanges, parentOf, visibleRows } from './tree-model';
import type { FolderListing } from '../../lib/files-api';

const marks = [
  { path: 'src/a.ts', mark: 'M' as const },
  { path: 'docs/new/', mark: 'N' as const },
];

describe('file marks', () => {
  it('uses the exact mark, or new for a file inside a new folder', () => {
    expect(fileMark('src/a.ts', marks)).toBe('M');
    expect(fileMark('docs/new/x.md', marks)).toBe('N');
    expect(fileMark('src/b.ts', marks)).toBeNull();
  });
  it('says a folder holds changes when something under it is marked', () => {
    expect(folderHasChanges('src', marks)).toBe(true);
    expect(folderHasChanges('docs', marks)).toBe(true);
    expect(folderHasChanges('docs/new/deep', marks)).toBe(true);
    expect(folderHasChanges('lib', marks)).toBe(false);
  });
});

describe('visible rows', () => {
  const listings: Record<string, FolderListing> = {
    '': { truncated: false, entries: [{ name: 'src', path: 'src', isDir: true, size: 0 }, { name: 'a.txt', path: 'a.txt', isDir: false, size: 1 }] },
    src: { truncated: false, entries: [{ name: 'x.ts', path: 'src/x.ts', isDir: false, size: 1 }] },
  };
  it('lists children only under an opened folder', () => {
    expect(visibleRows('', 0, listings, new Set()).map((r) => r.entry.path)).toEqual(['src', 'a.txt']);
    const rows = visibleRows('', 0, listings, new Set(['src']));
    expect(rows.map((r) => [r.entry.path, r.depth])).toEqual([['src', 0], ['src/x.ts', 1], ['a.txt', 0]]);
  });
  it('finds the parent folder', () => {
    expect(parentOf('src/a/b.ts')).toBe('src/a');
    expect(parentOf('a.ts')).toBe('');
  });
});
