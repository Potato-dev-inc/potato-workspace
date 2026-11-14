// "Open in my editor": which editors this computer has, which one the person chose, and the call that opens a file
// (at a line) in it. The choice is kept on this computer (a per-person convenience), as the editor's id, never a path:
// the backend only ever starts an editor program it found itself.
import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

export interface EditorOption {
  id: string;
  name: string;
}

/** The calls (a test double can stand in). */
export interface EditorApi {
  found(): Promise<EditorOption[]>;
  open(paneId: string, path: string, editor: string, line?: number): Promise<void>;
}

export const editorApi: EditorApi = {
  found: () => invoke<EditorOption[]>('editors_found'),
  open: (paneId, path, editor, line) => invoke<void>('open_in_editor', { paneId, path, editor, line }),
};

const KEY = 'pm-my-editor';
const listeners = new Set<() => void>();
let memory: string | null = null;

export function getMyEditor(): string | null {
  try {
    return globalThis.localStorage?.getItem(KEY) ?? memory;
  } catch {
    return memory;
  }
}

/** The person's choice; null forgets it (the first installed editor is used again). */
export function setMyEditor(id: string | null): void {
  memory = id;
  try {
    if (id) globalThis.localStorage?.setItem(KEY, id);
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* private mode: the choice lasts until the window closes */
  }
  listeners.forEach((l) => l());
}

function useChoice(): string | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getMyEditor,
    getMyEditor,
  );
}

export interface MyEditor {
  /** Every editor found; null while the search runs. */
  editors: EditorOption[] | null;
  /** The one that opens a file: the choice when it is still installed, else the only or first one found. */
  mine: EditorOption | null;
  choose: (id: string | null) => void;
}

/** The editors on this computer and the one in use. */
export function useMyEditor(api: EditorApi = editorApi): MyEditor {
  const [editors, setEditors] = useState<EditorOption[] | null>(null);
  const choice = useChoice();
  useEffect(() => {
    let cancelled = false;
    api.found().then(
      (list) => !cancelled && setEditors(list),
      () => !cancelled && setEditors([]),
    );
    return () => {
      cancelled = true;
    };
  }, [api]);
  const mine = editors ? pickEditor(editors, choice) : null;
  const choose = useCallback((id: string | null) => setMyEditor(id), []);
  return { editors, mine, choose };
}

/** Which of `editors` opens a file: the chosen one when it is installed, else the first. */
export function pickEditor(editors: readonly EditorOption[], choice: string | null): EditorOption | null {
  return editors.find((e) => e.id === choice) ?? editors[0] ?? null;
}
