// One quiet card: keep the same link every time. "Set it up" opens the guided setup sheet that already exists;
// "Not now" hides the card for about two weeks. No stripe, no alarm: a raised fill like the other Connect notes.
import { useState } from 'react';
import { useT } from '../../i18n';
import { snoozeOffer } from '../../lib/connect-offer';
import type { TunnelStatus } from '../../lib/tauri-types';
import { StableLinkSheet } from '../StableLinkSheet';
import type { TunnelApi } from '../settings/TunnelSection';

export function StableOffer({ tunnel, status, onStatus, onGone }: { tunnel: TunnelApi; status: TunnelStatus | null; onStatus: (s: TunnelStatus) => void; onGone: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="cn-offer" data-testid="connect-offer" role="group" aria-label={t('connect.offer.aria')}>
      <p className="cn-offer-text">{t('connect.offer.text')}</p>
      <div className="cn-offer-actions">
        <button type="button" className="ck-btn" data-testid="connect-offer-set" onClick={() => setOpen(true)}>
          {t('connect.offer.set')}
        </button>
        <button
          type="button"
          className="ck-btn"
          data-testid="connect-offer-later"
          onClick={() => {
            snoozeOffer();
            onGone();
          }}
        >
          {t('connect.offer.later')}
        </button>
      </div>
      {open && <StableLinkSheet api={tunnel} initial={status} onStatus={onStatus} onClose={() => setOpen(false)} />}
    </div>
  );
}
