// Messages the person wrote that the agent has not shown in the conversation yet: waiting, being sent, just sent,
// or failed. They sit at the bottom of the chat as bubbles; the real message replaces the bubble once the agent's
// session (or the screen) shows it. On the desktop they read as a short stacked queue (one slim row each, in order);
// the phone keeps its bubbles (phone-chat.css).
import { useState } from 'react';
import type { OutboxMessage } from '../../lib/paneOutbox';
import '../../styles/chat-input-card.css';

export interface PendingMessagesProps {
  messages: readonly OutboxMessage[];
  /** Cancels a waiting message. Resolves to null, or to the reason it could not be cancelled. */
  onCancel: (messageId: string) => Promise<string | null>;
  /** Keeps a waiting message back while it is edited (`true`), or lets it go on (`false`). Resolves to null, or the reason. */
  onHold?: (messageId: string, hold: boolean) => Promise<string | null>;
  /** Saves the edited text in the same place of the queue. Resolves to null, or the reason. With `onHold`, a waiting message has Edit. */
  onEdit?: (messageId: string, text: string) => Promise<string | null>;
  /** Takes a failed message off the list. */
  onHide: (messageId: string) => void;
  /**
   * "Send now": stops the turn that runs so the waiting message goes at once. Given only where a turn can be
   * stopped from here (a chat session, a Chat (terminal) pane); without it a waiting message has Cancel only.
   */
  onSendNow?: () => void;
}

/** The backend's sentence for a message that waits for the turn to end (pane_outbox `WAIT_BUSY`). */
const WAITING_FOR_TURN = 'The agent is working.';
export const WAITING_FOR_TURN_WORDS = 'Waiting for the turn to end';
/** The outbox's sentence for a message behind a menu or setup screen (pane_outbox `WAIT_MENU`). Known and plain, so it shows as is. */
const WAITING_FOR_MENU = 'Waiting for the agent. If it asks something, answer it first.';
const WAITING_FOR_AGENT = 'Waiting for the agent to finish.';

/** The plain sentence for a waiting message. Unknown backend text never shows. */
function waitingLabel(waitingFor: string | null, canSendNow: boolean): string {
  if (waitingFor === WAITING_FOR_MENU) return WAITING_FOR_MENU;
  if (canSendNow && waitingFor?.startsWith(WAITING_FOR_TURN)) return WAITING_FOR_TURN_WORDS;
  return WAITING_FOR_AGENT;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

type BubbleProps = Pick<PendingMessagesProps, 'onCancel' | 'onHold' | 'onEdit' | 'onSendNow'> & { message: OutboxMessage; index: number; onHide: (id: string) => void };

/** The small editor of a waiting message: the message is held back while it is open and nothing is sent early. */
function Editor({ message, onHold, onEdit, onDone }: { message: OutboxMessage; onHold: NonNullable<PendingMessagesProps['onHold']>; onEdit: NonNullable<PendingMessagesProps['onEdit']>; onDone: (note: string | null) => void }) {
  const [text, setText] = useState(message.text);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const empty = text.trim() === '';
  const save = () => {
    if (empty || busy) return;
    setBusy(true);
    void onEdit(message.id, text).then((refused) => {
      setBusy(false);
      if (refused) setError(refused);
      else onDone(null);
    });
  };
  const cancel = () => {
    void onHold(message.id, false).then(() => onDone(null));
  };
  return (
    <div className="ck-chat-pending-edit" data-testid="chat-pending-editor">
      <textarea
        className="ck-chat-pending-edit-box"
        aria-label="Edit the waiting message"
        value={text}
        autoFocus
        rows={Math.min(6, Math.max(2, text.split('\n').length))}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancel();
          else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
        }}
      />
      <div className="ck-chat-pending-meta">
        <button type="button" className="ck-chat-link" data-testid="chat-pending-edit-save" disabled={empty || busy} onClick={save}>
          Save
        </button>
        <span aria-hidden="true">·</span>
        <button type="button" className="ck-chat-link" data-testid="chat-pending-edit-cancel" disabled={busy} onClick={cancel}>
          Cancel
        </button>
        {error && (
          <span role="alert" data-testid="chat-pending-edit-error">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

function Bubble({ message, index, onCancel, onHold, onEdit, onHide, onSendNow }: BubbleProps) {
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const { state } = message;
  const canEdit = state === 'queued' && !!onHold && !!onEdit;
  return (
    <div className="flex justify-end ck-chat-pending" data-testid="chat-pending" data-state={state}>
      <div className={`max-w-[85%] ck-chat-pending-body${state === 'failed' ? ' ck-chat-pending-body--failed' : ''}`}>
        <span className="ck-q-n" aria-hidden="true">
          {index + 1}
        </span>
        {editing && onHold && onEdit ? (
          <Editor
            message={message}
            onHold={onHold}
            onEdit={onEdit}
            onDone={(done) => {
              setEditing(false);
              setNote(done);
            }}
          />
        ) : (
          <div className="whitespace-pre-wrap break-words ck-chat-bubble ck-chat-bubble--pending" title={message.text}>
            {message.text}
          </div>
        )}
        <div className="ck-chat-pending-meta">
          {state === 'queued' && !editing && (
            <>
              <span data-testid="chat-pending-waiting">{waitingLabel(message.waitingFor, Boolean(onSendNow))}</span>
              {onSendNow && message.waitingFor?.startsWith(WAITING_FOR_TURN) && (
                <>
                  <span aria-hidden="true">·</span>
                  <button type="button" className="ck-chat-link" data-testid="chat-pending-send-now" onClick={onSendNow}>
                    Send now
                  </button>
                  <span aria-hidden="true">·</span>
                </>
              )}
              {canEdit && (
                <>
                  <button
                    type="button"
                    className="ck-chat-link"
                    data-testid="chat-pending-edit"
                    onClick={() => {
                      void onHold!(message.id, true).then((refused) => {
                        if (refused) setNote(refused);
                        else setEditing(true);
                      });
                    }}
                  >
                    Edit
                  </button>
                  <span aria-hidden="true">·</span>
                </>
              )}
              <button
                type="button"
                className="ck-chat-link"
                data-testid="chat-pending-remove"
                onClick={() => {
                  void onCancel(message.id).then(setNote);
                }}
              >
                Remove
              </button>
            </>
          )}
          {state === 'sending' && <span>Sending…</span>}
          {state === 'sent' && <span>Sent</span>}
          {state === 'failed' && (
            <>
              <span role="alert" data-testid="chat-pending-error">
                {message.error ?? 'Could not send the message.'}
              </span>
              <button
                type="button"
                className="ck-chat-link"
                onClick={() => {
                  void copy(message.text).then((ok) => setNote(ok ? 'Copied.' : 'Could not copy.'));
                }}
              >
                Copy text
              </button>
              <button type="button" className="ck-chat-link" onClick={() => onHide(message.id)}>
                Hide
              </button>
            </>
          )}
          {note && <span data-testid="chat-pending-note">{note}</span>}
        </div>
      </div>
    </div>
  );
}

export function PendingMessages({ messages, onCancel, onHold, onEdit, onHide, onSendNow }: PendingMessagesProps) {
  if (messages.length === 0) return null;
  return (
    <div className="space-y-2 ck-chat-pending-list" aria-live="polite">
      {messages.map((message, index) => (
        <Bubble key={message.id} message={message} index={index} onCancel={onCancel} onHold={onHold} onEdit={onEdit} onHide={onHide} onSendNow={onSendNow} />
      ))}
    </div>
  );
}
