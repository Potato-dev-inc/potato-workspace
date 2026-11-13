// An approval inside the conversation (phone part 2, P7): who asks, one sentence, the exact command, one line about the risk
// (green, yellow or red with words and a glyph), and two big buttons. A high-risk "Allow" needs a one-second press and hold.
// Once answered the card shrinks to one line. It is the PC's attention item drawn small (`cardView`), so it never says more or less
// than the desktop card, and the answer goes through the same fingerprint check (`useCardAnswer`).
import { useEffect, useRef } from 'react';
import { useT } from '../../i18n';
import type { AttentionItem } from '../../lib/attention';
import { cardView, isDenyLabel, type LocalAnswer } from '../../lib/approval-card';
import { COPY } from '../../lib/attention-copy';
import type { BridgeClient } from '../../lib/bridge-types';
import { useCardAnswer } from '../../hooks/useCardAnswer';
import { RiskGlyph } from '../cockpit/InboxCard';
import { HoldButton } from './HoldButton';
import '../../styles/phone-ask.css';

export function PhoneAskCard({
  item,
  bridge,
  canAnswer,
  onOpenPane,
  autoFocus = false,
  localOverride,
  onAnswered,
  onRefresh,
}: {
  item: AttentionItem;
  bridge: Pick<BridgeClient, 'answerAttention'> | null;
  canAnswer: boolean;
  onOpenPane?: (paneId: string) => void;
  autoFocus?: boolean;
  /** Tests and the harness drive a state without a request. */
  localOverride?: LocalAnswer;
  onAnswered?: () => void;
  onRefresh?: () => void;
}) {
  const t = useT();
  const { local, now, send, retry, reset } = useCardAnswer(bridge, item, onRefresh);
  const view = cardView(item, { canAnswer, local: localOverride ?? local, now });
  const root = useRef<HTMLElement>(null);
  const answered = local.phase === 'answered';
  useEffect(() => {
    if (answered) onAnswered?.();
    // Once per answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answered]);
  // High risk: the focus starts on the safe choice, never on Allow.
  useEffect(() => {
    if (!autoFocus) return;
    const target = view.buttons.find((b) => b.focus);
    if (!target) return;
    Array.from(root.current?.querySelectorAll<HTMLElement>('[data-choice]') ?? [])
      .find((el) => el.dataset.choice === target.id)
      ?.focus();
    // Once per card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const level = view.riskLevel ?? 'none';
  const paneId = item.pane?.id;

  // Shrunk: answered here, answered elsewhere.
  if (view.settled && view.state !== 'expired' && view.state !== 'gone') {
    return (
      <p className="ph-ask-line" data-testid="phone-ask-line" data-card-state={view.state} role="status">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="m3.5 8.5 3 3 6-6.5" />
        </svg>
        <span>
          <b>{view.heading}</b> · {view.status}
        </span>
      </p>
    );
  }

  // The PC's primary answer leads in weight and sits on the right (on a high-risk prompt that is Deny). On a high-risk prompt every
  // answer that is not a "No" needs the one-second press and hold.
  const buttons = view.buttons;
  const denies = new Set((item.prompt?.choices ?? []).filter(isDenyLabel).map((c) => c.id));
  const holdIds = new Set(level === 'high' ? buttons.filter((b) => !denies.has(b.id)).map((b) => b.id) : []);
  const ordered = [...buttons].sort((a, b) => Number(a.role === 'primary') - Number(b.role === 'primary'));

  return (
    <article
      ref={root}
      className={`ph-ask ph-ask--${level} ph-ask--${view.state}`}
      data-testid="phone-ask-card"
      data-card-state={view.state}
      aria-label={`${view.heading}: ${view.title}`}
    >
      <p className="ph-ask-who">{t('phone.ask.who', { name: view.heading })}</p>
      <p className="ph-ask-title">{view.title}</p>
      {view.summary && view.state !== 'no_prompt' && (
        <p className={view.summaryIsCommand ? 'ph-ask-cmd' : 'ph-ask-sentence'} data-testid="phone-ask-command">
          {view.summary}
        </p>
      )}
      {view.riskLevel && view.riskWord && (
        <p className="ph-ask-risk" data-risk={level}>
          <span aria-hidden="true">
            <RiskGlyph level={view.riskLevel} />
          </span>
          <span>{view.riskWord}</span>
        </p>
      )}
      {holdIds.size > 0 && view.state === 'open' && <p className="ph-ask-hint">{t('phone.ask.holdHint')}</p>}
      {view.status && (
        <p className="ph-ask-status" role={view.state === 'failed' || view.state === 'lost' || view.state === 'offline' ? 'alert' : 'status'}>
          {view.status}
        </p>
      )}
      {(ordered.length > 0 || view.retry || view.lookAgain || view.openPane) && (
        <div className="ph-ask-actions">
          {ordered.map((b) =>
            holdIds.has(b.id) ? (
              <HoldButton key={b.id} dataChoice={b.id} className={`ph-ask-btn${b.role === 'primary' ? ' ph-ask-btn--primary' : ''}`} label={b.label} disabled={b.disabled} onDone={() => send(b.id)} />
            ) : (
              <button
                key={b.id}
                type="button"
                data-choice={b.id}
                className={`ph-ask-btn${b.role === 'primary' ? ' ph-ask-btn--primary' : ''}`}
                disabled={b.disabled}
                onClick={() => send(b.id)}
              >
                {b.label}
              </button>
            ),
          )}
          {view.retry && (
            <button type="button" className="ph-ask-btn ph-ask-btn--primary" data-role="retry" onClick={retry}>
              {COPY.tryAgain}
            </button>
          )}
          {view.lookAgain && (
            <button type="button" className="ph-ask-btn ph-ask-btn--primary" data-role="look-again" onClick={reset}>
              {COPY.lookAgain}
            </button>
          )}
          {view.openPane && paneId && onOpenPane && (
            <button type="button" className="ph-ask-btn" data-role="open-pane" onClick={() => onOpenPane(paneId)}>
              {COPY.openPane}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
