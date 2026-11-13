// What a dropped file turns into at each place: the text typed at a terminal prompt, and the full path of a file
// dragged out of the app's own Changes list.
import { searchProjectFiles } from './projectFiles';
import type { DragPayload } from '../components/dnd/dragStore';

/** A path as it is typed at a prompt: in double quotes when it has a space or a quote-worthy character. */
export function pathForPrompt(path: string): string {
  return /[\s"'&()^%!;$`]/.test(path) ? `"${path.replace(/"/g, '')}"` : path;
}

/** The text typed for dropped paths: each one quoted if needed, a space after each, never a line break. */
export function promptText(paths: readonly string[]): string {
  return paths.map((p) => `${pathForPrompt(p)} `).join('');
}

/** The full path of a file dragged from a Changes list (`kind: 'file'`), or null when it cannot be found. */
export async function draggedFilePath(
  payload: DragPayload,
  search: typeof searchProjectFiles = searchProjectFiles,
): Promise<string | null> {
  if (payload.meta?.abs) return payload.meta.abs;
  const paneId = payload.meta?.paneId;
  if (!paneId) return null;
  try {
    const hits = await search(paneId, payload.id, 8);
    return hits.find((h) => h.path === payload.id)?.absPath ?? null;
  } catch {
    return null;
  }
}

/** `dir`, `file` or `missing` for each path (the desktop app looks). Empty outside the desktop app. */
export async function pathKinds(paths: readonly string[]): Promise<string[]> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window) || paths.length === 0) return [];
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string[]>('path_kinds', { paths: [...paths] });
}
