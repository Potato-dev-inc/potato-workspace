// "Closed chats": the chats the person closed, newest first. Reopen brings one back into the sidebar with its history;
// Delete removes it for good (after asking). Shown from the sidebar's "Closed chats" row.
import { useState } from 'react';
import { folderName, type ClosedChat, type ClosedChatsApi } from '../../lib/closedChats';
import '../../styles/cockpit-closed-chats.css';
import { formatAgo } from './history-model';
import { Sheet } from './Sheet';

type Ask = { kind: 'one'; chat: ClosedChat } | { kind: 'all' };

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
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => notify(e instanceof Error ? e.message : String(e));

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
  const confirmDelete = async () => {
    if (!ask) return;
    setBusy(true);
    try {
      if (ask.kind === 'one') await api.remove(ask.chat.id);
      else await api.removeAll();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
      setAsk(null);
      onChanged();
    }
  };

  if (ask) {
    return (
      <Sheet labelledBy="ck-closed-t" onClose={busy ? undefined : () => setAsk(null)}>
        <h2 className="ck-section" id="ck-closed-t">
          {ask.kind === 'one' ? 'Delete this chat?' : 'Delete all closed chats?'}
        </h2>
        <p className="ck-sub">{ask.kind === 'one' ? "Delete this chat? This can't be undone." : `Delete all ${chats.length} closed chats? This can't be undone.`}</p>
        <div className="ck-sheet-actions">
          <button type="button" className="ck-btn ck-btn--secondary" autoFocus disabled={busy} onClick={() => setAsk(null)}>
            Cancel
          </button>
          <button type="button" className="ck-btn ck-btn--primary" disabled={busy} onClick={() => void confirmDelete()}>
            Delete
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet labelledBy="ck-closed-t" role="dialog" onClose={onClose} className="ck-sheet--closed">
      <h2 className="ck-section" id="ck-closed-t">
        Closed chats
      </h2>
      <p className="ck-sub">Chats you closed. Reopen one to carry on, or delete it for good.</p>
      {chats.length === 0 ? (
        <p className="ck-closed-empty">No closed chats.</p>
      ) : (
        <ul className="ck-closed-list">
          {chats.map((chat) => (
            <li key={chat.id} className="ck-closed-row" data-testid="closed-chat-row">
              <div className="ck-closed-main">
                <span className="ck-closed-title">{chat.title ?? 'Untitled chat'}</span>
                <span className="ck-closed-meta">
                  {chat.label} · {folderName(chat.cwd)} · {formatAgo(Math.max(0, now - chat.updated_ms))}
                </span>
              </div>
              <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" disabled={busy} aria-label={`Reopen ${chat.title ?? 'Untitled chat'}`} onClick={() => void reopen(chat)}>
                Reopen
              </button>
              <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" disabled={busy} aria-label={`Delete ${chat.title ?? 'Untitled chat'}`} onClick={() => setAsk({ kind: 'one', chat })}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="ck-sheet-actions">
        {chats.length > 0 && (
          <button type="button" className="ck-btn ck-btn--plain ck-closed-all" disabled={busy} onClick={() => setAsk({ kind: 'all' })}>
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
