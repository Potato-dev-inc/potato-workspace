// A fake project folder for the tests of the Files card and the file tab.
import { ReadableStream as NodeReadable, DecompressionStream as NodeInflate } from 'node:stream/web';
import { vi } from 'vitest';
import { bytesOf, type FileBytes, type FileContent, type FilesApi, type FileStream, type FolderListing } from '../../lib/files-api';

/** The web view inflates a picture with ReadableStream + DecompressionStream; jsdom has neither, node has both. */
export function stubInflate() {
  vi.stubGlobal('ReadableStream', NodeReadable);
  vi.stubGlobal('DecompressionStream', NodeInflate);
}

const dir = (path: string): FolderListing['entries'][number] => ({ name: path.slice(path.lastIndexOf('/') + 1), path, isDir: true, size: 0 });
const file = (path: string, size = 10): FolderListing['entries'][number] => ({ name: path.slice(path.lastIndexOf('/') + 1), path, isDir: false, size });

export const TREE: Record<string, FolderListing> = {
  '': { truncated: false, entries: [dir('src'), dir('docs'), file('README.md'), file('logo.png')] },
  src: { truncated: false, entries: [file('src/app.ts'), file('src/new.ts')] },
  docs: { truncated: false, entries: [file('docs/guide.md')] },
};

export function fakeApi(over: Partial<FilesApi> = {}, contents: Record<string, FileContent> = {}, bytes: Record<string, FileBytes> = {}): FilesApi {
  return {
    list: vi.fn(async (_p: string, path: string) => TREE[path] ?? { entries: [], truncated: false }),
    read: vi.fn(async (_p: string, path: string) => contents[path] ?? { path, name: path.slice(path.lastIndexOf('/') + 1), size: 5, kind: 'text' as const, text: 'hello' }),
    readBytes: vi.fn(async (_p: string, path: string) => bytes[path] ?? { path, name: path.slice(path.lastIndexOf('/') + 1), size: 0, kind: 'bytes' as const, base64: '' }),
    openBytes: vi.fn(async (_p: string, path: string): Promise<FileStream> => {
      const b = bytes[path] ?? { path, name: path.slice(path.lastIndexOf('/') + 1), size: 0, kind: 'bytes' as const, base64: '' };
      const limit = 500 * 1024 * 1024;
      if (b.kind === 'too_large' || b.base64 == null) return { path, name: b.name, size: b.size, kind: 'too_large', limit };
      return { path, name: b.name, size: b.size, kind: 'stream', limit, source: { bytes: bytesOf(b.base64) } };
    }),
    openDefault: vi.fn(async () => undefined),
    marks: vi.fn(async () => [
      { path: 'src/app.ts', mark: 'M' as const },
      { path: 'src/new.ts', mark: 'N' as const },
    ]),
    searchContents: vi.fn(async () => ({ hits: [], truncated: false, cancelled: false, filesScanned: 0 })),
    cancelSearch: vi.fn(async () => undefined),
    reveal: vi.fn(async () => undefined),
    diff: vi.fn(async () => ''),
    write: vi.fn(async (_p: string, path: string, text: string) => ({ path, size: text.length, version: `v-${text.length}` })),
    ...over,
  };
}
