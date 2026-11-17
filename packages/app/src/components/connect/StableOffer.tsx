// One quiet card: keep the same link every time. "Set it up" starts the one-button relay setup (the screen that holds this
// card owns the sheet, so it is not closed when the saved setting flips and this card goes away);
// "Not now" hides the card for about two weeks. No stripe, no alarm: a raised fill like the other Connect notes.
import { useT } from '../../i18n';
import { snoozeOffer } from '../../lib/connect-offer';

export function StableOffer({ onSet, onGone }: { onSet: () => void; onGone: () => void }) {
  const t = useT();
  return (
    <div className="cn-offer" data-testid="connect-offer" role="group" aria-label={t('connect.offer.aria')}>
      <p className="cn-offer-text">{t('connect.offer.text')}</p>
      <div className="cn-offer-actions">
        <button type="button" className="ck-btn" data-testid="connect-offer-set" onClick={onSet}>
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
    </div>
  );
}
