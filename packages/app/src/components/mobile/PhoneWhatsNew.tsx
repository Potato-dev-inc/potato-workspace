// What's new on the phone: one column, the same highlights as the desktop tour (whatsnew/highlights/*.json), only the
// cards that suit a phone. It opens once per version by itself (the seen mark is kept on this phone) and any time from
// the menu, About > What's new. The demo sits on top of each card; "Try it" shows only when the phone can do the action.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { Demo } from '../../whatsnew/demos';
import { highlightsOf, latestVersion, lineOf, titleOf, tryOf } from '../../whatsnew/catalog';
import { usePrefersReducedMotion } from '../../whatsnew/hooks';
import { isSeen, markSeen } from '../../whatsnew/store';
import type { ActionName, Highlight } from '../../whatsnew/types';
import { Sheet } from './MobileSheet';
import '../../styles/whatsnew.css';

/** The actions a phone can run. Every other card is only read. */
export const PHONE_ACTIONS: readonly ActionName[] = ['settings.open'];

/** The cards for this phone in `version`. */
export const phoneCards = (version: string): Highlight[] => highlightsOf(version, { platform: 'phone' });

export function PhoneWhatsNewSheet({ version, onClose, onTry }: { version: string; onClose: () => void; onTry?: (card: Highlight) => void }) {
  const t = useT();
  const reduced = usePrefersReducedMotion();
  const cards = phoneCards(version);
  return (
    <Sheet title={t('whatsnew.newIn', { version })} onClose={onClose}>
      <div className="wn-phone" data-testid="phone-whatsnew">
        {cards.map((card) => (
          <article key={card.id} className="wn-phone-card" data-card={card.id}>
            <div className="wn-phone-demo">
              <Demo name={card.demo} area={card.area} play={!reduced} />
            </div>
            <h2 className="wn-h">{titleOf(card)}</h2>
            <p className="wn-line">{lineOf(card)}</p>
            {onTry && PHONE_ACTIONS.includes(card.try.action) && (
              <button type="button" className="ph-btn ph-btn--plain" onClick={() => onTry(card)}>
                {tryOf(card)}
              </button>
            )}
          </article>
        ))}
        <button type="button" className="ph-btn ph-btn--primary" onClick={onClose}>
          {t('whatsnew.done')}
        </button>
      </div>
    </Sheet>
  );
}

/**
 * The phone's What's new state: opens by itself once per version when `ready` (the phone is connected and nothing else
 * is asking for attention), and on `open()` from the menu. Opening marks the version as seen on this phone.
 */
export function usePhoneWhatsNew(ready: boolean, version: string = latestVersion()): { shown: boolean; open: () => void; close: () => void; version: string } {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (ready && !isSeen(version) && phoneCards(version).length > 0) {
      markSeen(version);
      setShown(true);
    }
  }, [ready, version]);
  return {
    shown,
    version,
    open: () => {
      markSeen(version);
      setShown(true);
    },
    close: () => setShown(false),
  };
}
