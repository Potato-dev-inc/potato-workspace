// Pure rules of the Files card: which mark a row shows, and the rows that are on screen.
import type { FileEntry, FileMark, FolderListing } from '../../lib/files-api';

export type Mark = 'M' | 'N';

/** The mark of a file: its own, or "new" when it lives in a folder git sees as new. */
export function fileMark(path: string, marks: readonly FileMark[]): Mark | null {
  for (const m of marks) {
    if (m.path === path) return m.mark;
    if (m.path.endsWith('/') && path.startsWith(m.path)) return 'N';
  }
  return null;
}

/** A folder holds changes when any mark sits under it (shown as a quiet dot, not a letter). */
export function folderHasChanges(path: string, marks: readonly FileMark[]): boolean {
  const prefix = `${path}/`;
  return marks.some((m) => m.path.startsWith(prefix) || (m.path.endsWith('/') && prefix.startsWith(m.path)));
}

export interface TreeRow {
  entry: FileEntry;
  depth: number;
  open: boolean;
}

/** The rows on screen: opened folders are followed by their loaded children. */
export function visibleRows(
  folder: string,
  depth: number,
  listings: Readonly<Record<string, FolderListing | undefined>>,
  open: ReadonlySet<string>,
): TreeRow[] {
  const listing = listings[folder];
  if (!listing) return [];
  const rows: TreeRow[] = [];
  for (const entry of listing.entries) {
    const isOpen = entry.isDir && open.has(entry.path);
    rows.push({ entry, depth, open: isOpen });
    if (isOpen) rows.push(...visibleRows(entry.path, depth + 1, listings, open));
  }
  return rows;
}

/** The folder part of a path: "src/a/b.ts" -> "src/a" ("" at the top). */
export function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
