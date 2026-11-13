// What waits for the PC in this chat. While the PC cannot be reached it says so ("1 message waits for your PC"); when the PC is back it
// asks before anything is sent: Send or Delete. Nothing leaves the phone by itself.
import { useState } from 'react';
import { useT } from '../../i18n';
import type { QueuedMessage } from '../../lib/phone-queue';
import '../../styles/phone-link.css';

export function PhoneQueueBar({
  waiting,
  reachable,
  onSend,
  onDiscard,
}: {
  waiting: QueuedMessage[];
  /** The PC can be reached now. */
  reachable: boolean;
  /** Sends them all. Resolves to null, or one plain sentence saying why not. */
  onSend: () => Promise<string | null>;
  onDiscard: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (waiting.length === 0) return null;
  const count = waiting.length;
  if (!reachable) {
    return (
      <div className="ph-bar" data-testid="phone-queue-waiting">
        <span role="status">{t('phone.queue.waiting', { count })}</span>
      </div>
    );
  }
  return (
    <div className="ph-bar" data-testid="phone-queue-ask" role="group" aria-label={t('phone.queue.ask', { count })}>
      <span>{error ?? t('phone.queue.ask', { count })}</span>
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
  );
}
