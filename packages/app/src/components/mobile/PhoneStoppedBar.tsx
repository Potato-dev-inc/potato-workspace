// After Stop: "Stopped · Continue" for 10 seconds, then it goes. Continue asks the agent to carry on, as a normal message.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import '../../styles/phone-link.css';

/** How long the bar stays. */
export const STOPPED_BAR_MS = 10_000;

export function PhoneStoppedBar({ onContinue, onGone }: { onContinue: () => Promise<string | null>; onGone: () => void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(onGone, STOPPED_BAR_MS);
    return () => window.clearTimeout(timer);
  }, [onGone]);
  return (
    <div className="ph-bar" data-testid="phone-stopped-bar">
      <span role="status">{error ?? t('phone.stopped.line')}</span>
      <button
        type="button"
        data-primary
        onClick={() => {
          void onContinue().then((refused) => {
            if (refused) setError(refused);
            else onGone();
          });
        }}
      >
        {t('phone.stopped.continue')}
      </button>
    </div>
  );
}
