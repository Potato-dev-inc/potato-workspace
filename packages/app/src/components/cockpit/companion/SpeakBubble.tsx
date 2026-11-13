// The bubble the companion opens by itself (proposal 17): one sentence, then Open / Later / Too much. Plus the one quiet
// offer to turn this on, shown once. Both sit beside the companion row.
import type { SpeakEvent } from '../../../lib/companionSpeak';
import { useT, type MessageKey } from '../../../i18n';
import { CompanionBubble, useAnchor } from './CompanionBubble';

const ROW = '.ck-companion-row';

export function speakKey(event: SpeakEvent): MessageKey {
  if (event.kind === 'waiting') return event.yesNo ? 'companion.speak.waitingYesNo' : 'companion.speak.waiting';
  return event.kind === 'finished' ? 'companion.speak.finished' : 'companion.speak.usage';
}

export function SpeakBubble({
  event,
  companionName,
  onOpen,
  onLater,
  onTooMuch,
}: {
  event: SpeakEvent;
  companionName: string;
  onOpen: () => void;
  onLater: () => void;
  onTooMuch: () => void;
}) {
  const t = useT();
  const anchor = useAnchor(ROW, event.key);
  return (
    <CompanionBubble face={event.kind === 'finished' ? 'celebrate' : 'needs-you'} label={t('companion.speak.region', { name: companionName })} anchor={anchor} onClose={onLater} testId="speak-bubble">
      <p className="ck-pbubble-line">{t(speakKey(event), { name: event.name, minutes: event.minutes ?? 0, percent: event.percent ?? 0 })}</p>
      <div className="ck-pbubble-actions">
        <button type="button" className="ck-btn ck-btn--tiny ck-btn--primary" onClick={onOpen}>
          {t('companion.speak.open')}
        </button>
        <button type="button" className="ck-btn ck-btn--tiny ck-btn--secondary" onClick={onLater}>
          {t('companion.speak.later')}
        </button>
        <button type="button" className="ck-btn ck-btn--tiny ck-btn--plain" onClick={onTooMuch}>
          {t('companion.speak.tooMuch')}
        </button>
      </div>
    </CompanionBubble>
  );
}

/** The one quiet line that offers it. Answering either way ends the offer for good. */
export function SpeakOffer({ companionName, onYes, onNo }: { companionName: string; onYes: () => void; onNo: () => void }) {
  const t = useT();
  const anchor = useAnchor(ROW, companionName);
  return (
    <CompanionBubble face="wave-hello" label={t('companion.speak.region', { name: companionName })} anchor={anchor} onClose={onNo} testId="speak-offer">
      <p className="ck-pbubble-line">{t('companion.speak.offer', { name: companionName })}</p>
      <div className="ck-pbubble-actions">
        <button type="button" className="ck-btn ck-btn--tiny ck-btn--primary" onClick={onYes}>
          {t('companion.speak.offerYes')}
        </button>
        <button type="button" className="ck-btn ck-btn--tiny ck-btn--plain" onClick={onNo}>
          {t('companion.speak.offerNo')}
        </button>
      </div>
    </CompanionBubble>
  );
}
