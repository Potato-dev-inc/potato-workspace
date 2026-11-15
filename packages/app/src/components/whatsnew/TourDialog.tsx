// The What's new tour: one highlight at a time, a demo on the left and the words on the right. Skip, Done, Esc and a click
// on the scrim all close it. "Try it" closes it and runs that highlight's action. Only the visible card's demo plays.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { Demo } from '../../whatsnew/demos';
import { lineOf, titleOf, tourOf, tryOf } from '../../whatsnew/catalog';
import { runAction } from '../../whatsnew/registry';
import { closeTour, markSeen } from '../../whatsnew/store';
import { useCatalogFilter, usePrefersReducedMotion } from '../../whatsnew/hooks';
import { useSheetKeys } from '../cockpit/Sheet';
import type { Highlight } from '../../whatsnew/types';
import '../../styles/whatsnew.css';

export function TourDialog({ version, notify }: { version: string; notify?: (text: string) => void }) {
  const t = useT();
  const filter = useCatalogFilter();
  const cards = tourOf(version, filter);
  const [at, setAt] = useState(0);
  const reduced = usePrefersReducedMotion();
  const box = useSheetKeys(() => finish());
  const next = useRef<HTMLButtonElement>(null);
  const last = cards.length - 1;
  const card: Highlight | undefined = cards[Math.min(at, Math.max(last, 0))];

  const finish = () => {
    markSeen(version);
    closeTour();
  };

  useEffect(() => next.current?.focus({ preventScroll: true }), []);

  // Left and Right move between cards (Esc and Tab are handled by the sheet keys).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setAt((n) => Math.min(n + 1, Math.max(cards.length - 1, 0)));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setAt((n) => Math.max(n - 1, 0));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cards.length]);

  if (!card) return null;

  const tryIt = () => {
    finish();
    const result = runAction(card.try.action, card.try.args ?? {});
    if (result === 'missing') notify?.(t('whatsnew.tryMissing'));
  };

  return (
    <div className="wn-scrim" data-testid="whatsnew-tour" onMouseDown={(e) => e.target === e.currentTarget && finish()}>
      <div ref={box} className="wn-tour" role="dialog" aria-modal="true" aria-labelledby="wn-tour-title">
        <div className="wn-stage">
          <Demo key={card.id} name={card.demo} area={card.area} play={!reduced} />
        </div>
        <div className="wn-txt">
          <div className="wn-top">
            <span className="wn-newtag">{t('whatsnew.newIn', { version })}</span>
            <span className="wn-count">{t('whatsnew.count', { n: at + 1, total: cards.length })}</span>
            <span className="wn-sp" />
            <button type="button" className="ck-btn ck-btn--sm ck-btn--plain" onClick={finish}>
              {t('whatsnew.skip')}
            </button>
          </div>
          <h2 id="wn-tour-title" className="wn-h">
            {titleOf(card)}
          </h2>
          <p className="wn-line">{lineOf(card)}</p>
          <button type="button" className="ck-btn ck-btn--secondary wn-try" onClick={tryIt}>
            {tryOf(card)}
          </button>
          <div className="wn-nav">
            <div className="wn-dots">
              {cards.map((c, n) => (
                <button key={c.id} type="button" aria-label={titleOf(c)} aria-current={n === at} onClick={() => setAt(n)} />
              ))}
            </div>
            <button type="button" className="ck-btn ck-btn--secondary" style={{ visibility: at === 0 ? 'hidden' : undefined }} disabled={at === 0} onClick={() => setAt(at - 1)}>
              {t('whatsnew.back')}
            </button>
            <button type="button" ref={next} className="ck-btn ck-btn--primary" onClick={() => (at >= last ? finish() : setAt(at + 1))}>
              {at >= last ? t('whatsnew.done') : t('whatsnew.next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
