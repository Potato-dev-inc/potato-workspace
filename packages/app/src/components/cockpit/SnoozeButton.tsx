// "Snooze 30 min" on an Inbox card: this card's alerts (phone, chat, Discord) go quiet for 30 minutes.
// The card stays in the Inbox and still counts. A high-risk approval or a consent card has no snooze: it always notifies.
import { useT } from '../../i18n';
import { useSnooze } from '../../lib/notify-store';

export function SnoozeButton({ keys }: { keys: string[] }) {
  const t = useT();
  const [snoozed, snoozeNow] = useSnooze(keys);
  return (
    <button type="button" className="ck-btn ck-btn--plain" data-snooze="" disabled={snoozed} title={t('notify.snooze.tip')} onClick={snoozeNow}>
      {snoozed ? t('notify.snoozed') : t('notify.snooze')}
    </button>
  );
}
