// "Closed chats": the chats the person closed, newest first. Reopen brings one back into the sidebar with its history;
// Delete hides it and shows the undo bar for 8 seconds; the chat is removed for good only when the bar ends.
// Shown from the sidebar's "Closed chats" row.
import { errorSentence } from '../../lib/sayError';
import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import { finishUndo, showUndo } from '../../lib/undo-bar';
import { folderName, type ClosedChat, type ClosedChatsApi } from '../../lib/closedChats';
import '../../styles/cockpit-closed-chats.css';
import { formatAgo } from './history-model';
import { Sheet } from './Sheet';

/** A chat with no title (or only spaces) is "Untitled chat", never blank and never "No messages". */
export const closedChatName = (chat: ClosedChat): string => chat.title?.trim() || 'Untitled chat';

export function ClosedChatsSheet({
  chats,
  api,
  now = Date.now(),
  onReopened,
  onChanged,
  onClose,
  notify,
}: {
  chats: ClosedChat[];
  api: Pick<ClosedChatsApi, 'reopen' | 'remove' | 'removeAll'>;
  now?: number;
  /** A chat came back as this pane. */
  onReopened: (paneId: string) => void;
  /** A chat was reopened or deleted: read the list again. */
  onChanged: () => void;
  onClose: () => void;
  notify: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  // Deleting hides the row at once and the bar says Undo for 8 seconds; the files go only when the bar ends.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const pendingBar = useRef<number | null>(null);
  const fail = (e: unknown) => notify(errorSentence(e));
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  // Closing the sheet makes a waiting delete final: the bar would otherwise offer an Undo for rows nobody sees.
  useEffect(
    () => () => {
      if (pendingBar.current !== null) finishUndo(pendingBar.current);
    },
    [],
  );

  const reopen = async (chat: ClosedChat) => {
    setBusy(true);
    try {
      const paneId = await api.reopen(chat.id);
      onChanged();
      onReopened(paneId);
    } catch (e) {
      fail(e);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const deleteWithUndo = (ids: string[], text: string, run: () => Promise<unknown>) => {
    setHidden((cur) => new Set([...cur, ...ids]));
    const barId = showUndo({
      text,
      failText: t('undo.commitFailed'),
      undo: () => {
        pendingBar.current = null;
        setHidden((cur) => new Set([...cur].filter((x) => !ids.includes(x))));
      },
      commit: async () => {
        if (pendingBar.current === barId) pendingBar.current = null;
        try {
          await run();
        } catch (e) {
          setHidden((cur) => new Set([...cur].filter((x) => !ids.includes(x))));
          throw e;
        } finally {
          onChangedRef.current();
        }
      },
    });
    pendingBar.current = barId;
  };

  const shown = chats.filter((c) => !hidden.has(c.id));

  return (
    <Sheet labelledBy="ck-closed-t" role="dialog" onClose={onClose} className="ck-sheet--closed">
      <h2 className="ck-section" id="ck-closed-t">
        Closed chats
      </h2>
      <p className="ck-sub">Chats you closed. Reopen one to carry on, or delete it (you can undo for a few seconds).</p>
      {shown.length === 0 ? (
        <p className="ck-closed-empty">No closed chats.</p>
      ) : (
        <ul className="ck-closed-list">
          {shown.map((chat) => {
            const name = closedChatName(chat);
            return (
              <li key={chat.id} className="ck-closed-row" data-testid="closed-chat-row">
                <div className="ck-closed-main">
                  <span className="ck-closed-title">{name}</span>
                  <span className="ck-closed-meta">
                    {chat.label} · {folderName(chat.cwd)} · {formatAgo(Math.max(0, now - chat.updated_ms))}
                  </span>
                </div>
                <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" disabled={busy} aria-label={`Reopen ${name}`} onClick={() => void reopen(chat)}>
                  Reopen
                </button>
                <button
                  type="button"
                  className="ck-btn ck-btn--plain ck-btn--sm ck-closed-delete"
                  disabled={busy}
                  aria-label={`Delete ${name}`}
                  onClick={() => deleteWithUndo([chat.id], t('undo.chatDeleted', { name }), () => api.remove(chat.id))}
                >
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="ck-sheet-actions">
        {shown.length > 0 && (
          <button
            type="button"
            className="ck-btn ck-btn--plain ck-closed-all"
            disabled={busy}
            onClick={() =>
              deleteWithUndo(
                shown.map((c) => c.id),
                t('undo.chatsDeleted', { count: shown.length }),
                () => api.removeAll(),
              )
            }
          >
            Delete all closed chats
          </button>
        )}
        <button type="button" className="ck-btn ck-btn--secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Sheet>
  );
}
