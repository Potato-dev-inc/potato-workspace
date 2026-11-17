// The phone approval card: what an agent wants to do, how risky that is in plain words, and the
// answers. It is the PC's attention item drawn small (`AttentionItem`), so it says what the desktop
// card says. High risk leads with Deny and focuses it, never Allow. A phone that may only watch sees
// the card without buttons. An answer in flight says so ("Sending", "Still sending") and, when it is
// lost, offers "Try again" with the same answer key. Monochrome: risk is a glyph, weight and words.
import { useEffect, useRef, useState } from 'react';
import type { AttentionItem } from '../../lib/attention';
import { cardView, isDenyLabel, type CardGlyph, type LocalAnswer } from '../../lib/approval-card';
import { COPY, askFacts } from '../../lib/attention-copy';
import { useT } from '../../i18n';
import { HoldButton } from './HoldButton';
import { ALWAYS } from './PhoneAskCard';
import type { BridgeClient } from '../../lib/bridge-types';
import { useCardAnswer } from '../../hooks/useCardAnswer';
import { RiskGlyph as Glyph } from '../cockpit/InboxCard';
import { DotSpinner } from '../cockpit/DotSpinner';
import '../../styles/mobile-approval.css';
import '../../styles/phone-ask.css';


const GLYPH_LABEL: Record<CardGlyph, string> = {
  waiting_input: 'Needs you',
  running: 'Sending',
  exited: 'Answered',
  idle: 'Gone',
  error: 'Not sent',
};

export function ApprovalCard({
  item,
  bridge,
  canAnswer,
  onOpenPane,
  variant = 'inline',
  autoFocus = false,
  localOverride,
  onAnswered,
  onRefresh,
}: {
  item: AttentionItem;
  bridge: Pick<BridgeClient, 'answerAttention'> | null;
  /** This phone holds the `answer` ability (`GET /attention` → `device.can_answer`). */
  canAnswer: boolean;
  onOpenPane?: (paneId: string) => void;
  /** `docked` sits above the terminal; `inline` is a card in the Needs you list; `full` is the risky ask's whole-screen card. */
  variant?: 'inline' | 'docked' | 'full';
  /** Move focus to the card's focus choice when it appears (a deep link, a docked card). */
  autoFocus?: boolean;
  /** Tests and the harness drive a state without a request. */
  localOverride?: LocalAnswer;
  /** This phone's own answer went through: the list lets the card leave 3 s later. */
  onAnswered?: () => void;
  /** The PC's list may have moved on (a refused or stale answer): read it again now instead of at the next poll. */
  onRefresh?: () => void;
}) {
  const t = useT();
  const { local, now, send, retry, reset } = useCardAnswer(bridge, item, onRefresh);
  const view = cardView(item, { canAnswer, local: localOverride ?? local, now });
  const [details, setDetails] = useState(false);
  const root = useRef<HTMLElement>(null);
  const answered = local.phase === 'answered';
  useEffect(() => {
    if (answered) onAnswered?.();
    // Once per answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answered]);

  // High risk: focus starts on Deny, never Allow, so a reflex tap cannot approve.
  useEffect(() => {
    if (!autoFocus) return;
    const target = view.buttons.find((b) => b.focus);
    if (!target) return;
    Array.from(root.current?.querySelectorAll<HTMLElement>('[data-choice]') ?? [])
      .find((el) => el.dataset.choice === target.id)
      ?.focus();
    // Focus once per card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const level = view.riskLevel ?? 'none';
  const paneId = item.pane?.id;
  const live = view.state === 'sending' ? 'polite' : undefined;


  if (variant === 'full') {
    // The risky ask: a plain question, three rows, "Do not allow" first, "Hold to allow once" second, the exact step folded.
    const facts = askFacts(item);
    const denyIds = new Set((item.prompt?.choices ?? []).filter(isDenyLabel).map((c) => c.id));
    const deny = view.buttons.filter((b) => denyIds.has(b.id));
    const allow = view.buttons.filter((b) => !denyIds.has(b.id) && !ALWAYS.test(b.label)).slice(0, 1);
    const open = view.state === 'open' && (deny.length > 0 || allow.length > 0);
    return (
      <article ref={root} className={`ph-full-card ph-full-card--${level} ph-full-card--${view.state}`} data-card-state={view.state} data-testid="risky-card" aria-label={`${view.heading}: ${view.title}`}>
        <p className="ph-full-who">
          {view.heading} · {view.meta}
        </p>
        {view.riskLevel && view.riskWord && (
          <p className="ph-full-risk" data-risk={level}>
            <span aria-hidden="true">
              <Glyph level={view.riskLevel} />
            </span>
            <span>{view.riskWord}</span>
          </p>
        )}
        <h2 className="ph-full-title">{t('phone.full.question', { what: view.title.replace(/[.?!。？！]+$/, '') })}</h2>
        {!view.settled && (
          <dl className="ph-full-rows">
            <div>
              <dt>{t('phone.full.what')}</dt>
              <dd>{facts.what}</dd>
            </div>
            <div>
              <dt>{t('phone.full.where')}</dt>
              <dd>{facts.where}</dd>
            </div>
            <div>
              <dt>{t('phone.full.undo')}</dt>
              <dd>{facts.undo}</dd>
            </div>
          </dl>
        )}
        {!view.settled && view.summary && (
          <>
            <button type="button" className="ph-full-step" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
              {details ? t('phone.full.hideStep') : t('phone.full.showStep')}
            </button>
            {details && (
              <code className="ph-full-code" data-testid="risky-exact-step">
                {view.summary}
              </code>
            )}
          </>
        )}
        {view.status && (
          <p className="ph-full-status" role={view.state === 'failed' || view.state === 'lost' || view.state === 'offline' ? 'alert' : 'status'} aria-live={live}>
            {view.status}
          </p>
        )}
        <div className="ph-full-foot">
          {open && deny.map((b) => (
            <button key={b.id} type="button" data-choice={b.id} className="ph-full-deny" disabled={b.disabled} onClick={() => send(b.id)}>
              {t('phone.full.deny')}
            </button>
          ))}
          {open && allow.map((b) => (
            <HoldButton key={b.id} dataChoice={b.id} className="ph-full-allow" label={t('phone.full.holdAllow')} disabled={b.disabled} onDone={() => send(b.id)} />
          ))}
          {view.retry && (
            <button type="button" className="ph-full-deny" data-role="retry" onClick={retry}>
              {COPY.tryAgain}
            </button>
          )}
          {view.lookAgain && (
            <button type="button" className="ph-full-deny" data-role="look-again" onClick={reset}>
              {COPY.lookAgain}
            </button>
          )}
        </div>
      </article>
    );
  }

  return (
    <article
      ref={root}
      className={`ph-appr ph-appr--${level} ph-appr--${view.state} ph-appr--${variant}`}
      data-card-state={view.state}
      data-item-kind={item.kind}
      aria-label={`${view.heading}: ${view.title}`}
    >
      <header className="ph-appr-head">
        <span className="ph-appr-glyph">
          <DotSpinner status={view.glyph} label={view.status && view.state !== 'open' ? view.status : GLYPH_LABEL[view.glyph]} />
        </span>
        <span className="ph-appr-pane">{view.heading}</span>
        <span className="ph-appr-meta">{view.meta}</span>
      </header>

      <div className="ph-appr-risk">
        {view.riskLevel && (
          <span className="ph-appr-riskglyph" aria-hidden="true">
            <Glyph level={view.riskLevel} />
          </span>
        )}
        <span className="ph-appr-title">{view.title}</span>
        {view.riskWord && <span className="ph-appr-word">{view.riskWord}</span>}
      </div>

      {!view.settled && view.runs.map((r) => (
        <p key={r} className="ph-appr-sentence">
          Runs: <code>{r}</code>
        </p>
      ))}
      {view.summary && !view.settled && (
        <p className={view.summaryIsCommand ? `ph-appr-cmd${details ? ' ph-appr-cmd--full' : ''}` : 'ph-appr-sentence'}>{view.summary}</p>
      )}
      {view.caution && <p className="ph-appr-caution">{view.caution}</p>}
      {view.status && (
        <p className={`ph-appr-status ph-appr-status--${view.state}`} role={view.state === 'failed' || view.state === 'lost' || view.state === 'offline' ? 'alert' : 'status'} aria-live={live}>
          {view.status}
        </p>
      )}

      {view.details && (view.reasons.length > 0 || view.summary) && (
        <>
          <button type="button" className="ph-appr-toggle" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
            {details ? COPY.hideDetails : COPY.showDetails}
          </button>
          {details && view.reasons.length > 0 && (
            <ul className="ph-appr-reasons">
              {view.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </>
      )}

      {(view.buttons.length > 0 || view.retry || view.lookAgain || view.openPane) && (
        <div className="ph-appr-actions">
          {view.buttons.map((b) => (
            <button
              key={b.id}
              type="button"
              data-choice={b.id}
              className={`ph-btn ${b.role === 'primary' ? 'ph-btn--primary' : ''}`}
              disabled={b.disabled}
              onClick={() => send(b.id)}
            >
              {b.label}
            </button>
          ))}
          {view.retry && (
            <button type="button" className="ph-btn ph-btn--primary" data-role="retry" onClick={retry}>
              {COPY.tryAgain}
            </button>
          )}
          {view.lookAgain && (
            <button type="button" className="ph-btn ph-btn--primary" data-role="look-again" onClick={reset}>
              {COPY.lookAgain}
            </button>
          )}
          {view.openPane && paneId && onOpenPane && (
            <button type="button" className="ph-btn ph-btn--plain" data-role="open-pane" onClick={() => onOpenPane(paneId)}>
              {COPY.openPane}
            </button>
          )}
        </div>
      )}

      {view.provenance && !view.settled && view.state === 'open' && <p className="ph-appr-prov">{view.provenance}</p>}
    </article>
  );
}
