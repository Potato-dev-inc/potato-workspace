// What waits for the PC in this chat: one small list, each message with Remove. While the PC cannot be reached the list says so
// ("1 message is waiting for your PC"); when the PC is back it asks before anything is sent: Send or Delete. Nothing leaves the phone by itself.
import { useState } from 'react';
import { useT } from '../../i18n';
import type { QueuedMessage } from '../../lib/phone-queue';
import '../../styles/phone-link.css';

export function PhoneQueueBar({
  waiting,
  reachable,
  onSend,
  onDiscard,
  onRemove,
  onEdit,
}: {
  waiting: QueuedMessage[];
  /** The PC can be reached now. */
  reachable: boolean;
  /** Sends them all. Resolves to null, or one plain sentence saying why not. */
  onSend: () => Promise<string | null>;
  onDiscard: () => void;
  /** Takes one message out of the list. Without it the list has no Remove buttons. */
  onRemove?: (id: string) => void;
  /** Saves new words for one message. Returns false when they are empty. Without it the list has no Edit buttons. */
  onEdit?: (id: string, text: string) => boolean;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  if (waiting.length === 0) return null;
  const count = waiting.length;
  const list = (
    <ul className="ph-qlist" aria-label={t('phone.sh.queueTitle')}>
      {waiting.map((message) =>
        editing?.id === message.id && onEdit ? (
          <li key={message.id}>
            <div className="ph-qedit">
              <textarea
                autoFocus
                aria-label={t('phone.sh.editBox')}
                value={editing.text}
                onChange={(e) => setEditing({ id: message.id, text: e.target.value })}
              />
              <div className="ph-qedit-actions">
                <button type="button" className="ph-qbtn" onClick={() => setEditing(null)}>
                  {t('phone.sh.cancel')}
                </button>
                <button
                  type="button"
                  data-primary
                  disabled={editing.text.trim() === ''}
                  onClick={() => {
                    if (onEdit(message.id, editing.text)) setEditing(null);
                  }}
                >
                  {t('phone.sh.save')}
                </button>
              </div>
            </div>
          </li>
        ) : (
        <li key={message.id}>
          <span className="ph-qtext">{message.text}</span>
          {onEdit && (
            <button type="button" className="ph-qbtn" aria-label={t('phone.sh.editNamed', { text: message.text.slice(0, 40) })} onClick={() => setEditing({ id: message.id, text: message.text })}>
              {t('phone.sh.edit')}
            </button>
          )}
          {onRemove && (
            <button type="button" className="ph-qremove" aria-label={t('phone.sh.removeNamed', { text: message.text.slice(0, 40) })} onClick={() => onRemove(message.id)}>
              {t('phone.sh.remove')}
            </button>
          )}
        </li>
        ),
      )}
    </ul>
  );
  if (!reachable) {
    return (
      <div className="ph-bar ph-bar--list" data-testid="phone-queue-waiting">
        <span role="status">{t('phone.queue.waiting', { count })}</span>
        {list}
      </div>
    );
  }
  return (
    <div className="ph-bar ph-bar--list" data-testid="phone-queue-ask" role="group" aria-label={t('phone.queue.ask', { count })}>
      <span>{error ?? t('phone.queue.ask', { count })}</span>
      {list}
      <div className="ph-bar-actions">
      <button type="button" onClick={onDiscard} disabled={busy}>
        {t('phone.queue.delete')}
      </button>
      <button
        type="button"
        data-primary
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void onSend().then((refused) => {
            setBusy(false);
            setError(refused);
          });
        }}
      >
        {t('phone.queue.send')}
      </button>
      </div>
    </div>
  );
}
