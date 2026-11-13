// A fake project folder for the tests of the Files card and the file tab.
import { vi } from 'vitest';
import type { FileContent, FilesApi, FolderListing } from '../../lib/files-api';

const dir = (path: string): FolderListing['entries'][number] => ({ name: path.slice(path.lastIndexOf('/') + 1), path, isDir: true, size: 0 });
const file = (path: string, size = 10): FolderListing['entries'][number] => ({ name: path.slice(path.lastIndexOf('/') + 1), path, isDir: false, size });

export const TREE: Record<string, FolderListing> = {
  '': { truncated: false, entries: [dir('src'), dir('docs'), file('README.md'), file('logo.png')] },
  src: { truncated: false, entries: [file('src/app.ts'), file('src/new.ts')] },
  docs: { truncated: false, entries: [file('docs/guide.md')] },
};

export function fakeApi(over: Partial<FilesApi> = {}, contents: Record<string, FileContent> = {}): FilesApi {
  return {
    list: vi.fn(async (_p: string, path: string) => TREE[path] ?? { entries: [], truncated: false }),
    read: vi.fn(async (_p: string, path: string) => contents[path] ?? { path, name: path.slice(path.lastIndexOf('/') + 1), size: 5, kind: 'text' as const, text: 'hello' }),
    marks: vi.fn(async () => [
      { path: 'src/app.ts', mark: 'M' as const },
      { path: 'src/new.ts', mark: 'N' as const },
    ]),
    reveal: vi.fn(async () => undefined),
    diff: vi.fn(async () => ''),
    ...over,
  };
}
