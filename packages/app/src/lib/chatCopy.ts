// "Work on a copy" for chat sessions: what the copy changed, and Keep / Throw away. One small API over the backend's
// `acp_chat_copy*` commands, and the hook the pane reads. No agent names here.
import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';
import { t } from '../i18n';
import { sayError } from './sayError';
import { showUndo } from './undo-bar';

export interface ChatCopySummary {
  kind: 'git' | 'plain';
  files: number;
  additions: number | null;
  deletions: number | null;
}

export interface ChatCopyApi {
  summary: (paneId: string) => Promise<ChatCopySummary | null>;
  keep: (paneId: string) => Promise<{ kept: boolean; files: number }>;
  discard: (paneId: string) => Promise<void>;
}

export const tauriChatCopyApi: ChatCopyApi = {
  summary: (paneId) => invoke<ChatCopySummary | null>('acp_chat_copy', { paneId }),
  keep: (paneId) => invoke<{ kept: boolean; files: number }>('acp_chat_copy_keep', { paneId }),
  discard: (paneId) => invoke<void>('acp_chat_copy_discard', { paneId }),
};

/** One plain sentence from a backend error (`CODE: sentence`). */
export const copyErrorText = (error: unknown): string => sayError(error, 'chat copy', t('chatCopy.failed')).text;

/** "3 files changed" / "No changes yet". */
export const copyFilesText = (files: number): string => (files === 0 ? t('chatCopy.noChanges') : t('chatCopy.files', { count: files }));

/**
 * What the copy changed, for a chat that works on a copy (`isCopy`). Read again whenever the chat's status changes (a
 * turn ended), so the numbers are fresh when the buttons matter.
 */
export function useChatCopy(paneId: string, isCopy: boolean, status: string, api: ChatCopyApi = tauriChatCopyApi) {
  const [summary, setSummary] = useState<ChatCopySummary | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!isCopy) {
      setSummary(null);
      return;
    }
    let live = true;
    api.summary(paneId).then((s) => live && setSummary(s)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [paneId, isCopy, status, api]);

  /** Keep the changes: the project gets them, the copy and this chat close. */
  const keep = useCallback(
    async (notify: (text: string) => void) => {
      setBusy(true);
      try {
        const done = await api.keep(paneId);
        notify(done.kept ? t('chatCopy.kept', { files: copyFilesText(done.files) }) : t('chatCopy.nothingToKeep'));
      } catch (error) {
        notify(copyErrorText(error));
      } finally {
        setBusy(false);
      }
    },
    [api, paneId],
  );

  /** Throw the copy away: waits in the undo bar for a few seconds, then it is final. */
  const discard = useCallback(
    (notify: (text: string) => void, onUndone?: () => void) => {
      showUndo({
        text: t('chatCopy.thrownAway'),
        undo: () => onUndone?.(),
        commit: async () => {
          try {
            await api.discard(paneId);
          } catch (error) {
            notify(copyErrorText(error));
          }
        },
        failText: t('chatCopy.failed'),
      });
    },
    [api, paneId],
  );

  return { summary, busy, keep, discard };
}
