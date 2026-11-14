import { useState } from 'react';
import { useT } from '../../i18n';
import { cleanName } from '../../lib/lend';
import '../../styles/lend.css';

/**
 * The lender's "Take back" on an active lend. It asks first (the borrower's agent stops at once), then runs `onConfirm`.
 * The same word on every screen: the lender takes back, the borrower gives back.
 */
export function TakeBack({ profile, peer, busy, onConfirm }: { profile?: string; peer: string; busy?: boolean; onConfirm: () => void }) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className="lend-btn is-small" disabled={busy} onClick={() => setAsking(true)}>
        {t('lend.takeBack')}
      </button>
    );
  }
  return (
    <span className="lend-confirm" role="group" aria-label={t('lend.takeBack')}>
      <span>{t('lend.takeBack.ask', { profile: cleanName(profile) || t('lend.thisProfile'), peer })}</span>
      <button
        type="button"
        className="lend-btn is-small is-primary"
        disabled={busy}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {t('lend.takeBack')}
      </button>
      <button type="button" className="lend-btn is-small is-plain" onClick={() => setAsking(false)}>
        {t('lend.takeBack.keep')}
      </button>
    </span>
  );
}
