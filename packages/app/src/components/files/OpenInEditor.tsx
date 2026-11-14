// "Open in my editor" for the places that show a file: the menu items of a right-click, and a hook for a button or a key.
// The editor is the one the person chose (Settings > General > My editor), else the first one found. The backend only
// starts an editor program it found itself, with a file inside the pane's project folder.
import { useCallback } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import { editorApi, getMyEditor, setMyEditor, useMyEditor, type EditorApi } from '../../lib/my-editor';

export interface OpenInEditor {
  /** Name of the editor that would open, for a label; null while looking, or when there is none. */
  name: string | null;
  /** The search is done and found nothing. */
  none: boolean;
  /** Opens `path` (relative to the project, or an absolute path inside it) at `line`. Resolves to a plain error sentence, or null when it started. */
  open: (path: string, line?: number) => Promise<string | null>;
}

export function useOpenInEditor(paneId: string, api: EditorApi = editorApi): OpenInEditor {
  const t = useT();
  const { editors, mine } = useMyEditor(api);
  const open = useCallback(
    async (path: string, line?: number): Promise<string | null> => {
      if (!mine) return t('editor.none');
      try {
        await api.open(paneId, path, mine.id, line);
        return null;
      } catch (err) {
        return t('editor.failed', { reason: errorSentence(err) });
      }
    },
    [api, mine, paneId, t],
  );
  return { name: mine?.name ?? null, none: editors !== null && editors.length === 0, open };
}

/**
 * The menu items for a file in a `FloatingMenu`. One editor to open it in (the chosen or the first); when the person
 * has chosen none and several are installed, one item for each, and picking one makes it theirs.
 */
export function EditorMenuItems({
  paneId,
  path,
  onDone,
  onFail,
  api = editorApi,
}: {
  paneId: string;
  path: string;
  /** The menu can close. */
  onDone: () => void;
  /** An error sentence to show. */
  onFail: (text: string) => void;
  api?: EditorApi;
}) {
  const t = useT();
  const { editors, mine } = useMyEditor(api);
  if (editors === null) return null;
  if (editors.length === 0) {
    return (
      <button type="button" role="menuitem" className="ck-menu-item" disabled title={t('editor.none')}>
        {t('editor.openGeneric')}
      </button>
    );
  }
  const run = (id: string, remember: boolean) => {
    onDone();
    if (remember) setMyEditor(id);
    api.open(paneId, path, id).catch((err: unknown) => onFail(t('editor.failed', { reason: errorSentence(err) })));
  };
  const list = mine && (editors.length === 1 || getMyEditor() === mine.id) ? [mine] : editors;
  return (
    <>
      {list.map((e) => (
        <button key={e.id} type="button" role="menuitem" className="ck-menu-item" onClick={() => run(e.id, list.length > 1)}>
          {t('editor.open', { name: e.name })}
        </button>
      ))}
    </>
  );
}
