// Where the message box would be, when the PC's rule for this agent keeps this phone from typing: one sentence and "Ask the PC for
// control". The PC shows a small notice; the person there allows it for 15 minutes or says no. One ask per agent per 5 minutes.
import { useState } from 'react';
import { useT } from '../../i18n';
import type { RuleLimit } from '../../lib/pane-rule-view';
import { errorSentence } from '../../lib/sayError';
import '../../styles/phone-link.css';

export function PhoneNoControl({
  limit,
  onAsk,
}: {
  limit: RuleLimit;
  /** Asks the PC. Resolves to what happened. */
  onAsk: () => Promise<{ asked: boolean; reason?: string }>;
}) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'asking' | 'asked' | 'already' | 'recently' | 'failed'>('idle');
  const ask = () => {
    setState('asking');
    onAsk().then(
      (reply) => setState(reply.asked ? 'asked' : 'already'),
      (error: unknown) => setState(/ -> 429/.test(errorSentence(error)) ? 'recently' : 'failed'),
    );
  };
  const sentence = limit === 'off' ? t('phone.control.off') : t('phone.control.watchOnly');
  const note =
    state === 'asked' ? t('phone.control.asked')
    : state === 'already' ? t('phone.control.already')
    : state === 'recently' ? t('phone.control.recently')
    : state === 'failed' ? t('phone.control.failed')
    : null;
  return (
    <div className="ph-nocontrol" data-testid="phone-no-control">
      <p>{sentence}</p>
      <button type="button" onClick={ask} disabled={state === 'asking' || state === 'asked'}>
        {t('phone.control.ask')}
      </button>
      {note && (
        <p className="ph-nocontrol-note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
