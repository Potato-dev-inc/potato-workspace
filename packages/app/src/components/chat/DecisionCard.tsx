// The card for one permission question of a chat session: who asks, what kind of action it is, the command or title
// (cut to two lines, with "Show full"), the agent's own options as buttons (a yes is the filled one, a no is quiet),
// and "Don't ask again in this chat" for kinds that are safe to remember. Deleting and moving ask for a held press.
// Nothing here picks an answer for the person; the card only reports which option was pressed.
import { useId, useState } from 'react';
import type { AcpPermission } from '../../lib/acpChat';
import { canRemember, decisionOptions, forceYesLeft, isLong, isRisky, kindWords, whatIsAsked } from '../../lib/decisionCard';
import type { Question } from '../../lib/questions';
import { useT } from '../../i18n';
import { HoldButton } from './HoldButton';
import '../../styles/chips.css';
import '../../styles/chat-decision-card.css';

export interface DecisionAnswer {
  choiceId: string;
  /** The person turned "Don't ask again" on and pressed a yes. */
  remember: boolean;
}

export function DecisionCard({
  q,
  permission,
  label,
  waiting,
  canRememberHere,
  onAnswer,
  onDismiss,
}: {
  q: Question;
  permission: AcpPermission | null;
  /** The agent's name. */
  label: string;
  /** How many more questions wait behind this one. */
  waiting: number;
  /** The backend can remember a kind for this chat. */
  canRememberHere: boolean;
  onAnswer: (answer: DecisionAnswer) => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const left = forceYesLeft(q);
  const [never, setNever] = useState(false);
  const bodyId = useId();
  const kind = permission?.toolKind ?? null;
  const chip = kindWords(kind);
  const risky = isRisky(kind);
  const what = whatIsAsked(q, permission);
  const options = decisionOptions(q, permission);
  const rememberable = canRememberHere && canRemember(kind) && options.some((o) => o.tone === 'allow');
  const firstAllow = options.find((o) => o.tone === 'allow')?.id;
  const answer = (choiceId: string, yes: boolean) => onAnswer({ choiceId, remember: yes && never && rememberable });

  return (
    <div className="ck-dc" role="group" aria-label={t('decision.region')} data-testid="decision-card" data-question-id={q.id} data-risky={risky ? '' : undefined}>
      <div className="ck-dc-head">
        <span className="ck-dc-who">{label}</span>
        <span className="ck-dc-q">{t('decision.wantsTo')}</span>
        {chip && (
          <span className="ck-dc-chip" data-testid="decision-kind">
            {chip}
          </span>
        )}
        {risky && <span className="ck-chip-label is-risk ck-dc-chip ck-dc-chip--risk">{t('decision.risky')}</span>}
      </div>
      {what && (
        <>
          <div id={bodyId} className="ck-dc-cmd" data-open={open ? '' : undefined} data-testid="decision-what">
            <span className="ck-dc-cmd-tx">{what}</span>
          </div>
          {isLong(what) && (
            <button type="button" className="ck-dc-more" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
              {open ? t('decision.showLess') : t('decision.showFull')}
            </button>
          )}
        </>
      )}
      {left && (
        <div className="ck-dc-queue" data-testid="decision-force-yes-left">
          {t('forceYes.left')} {t(`forceYes.left.${left}` as never)}
        </div>
      )}
      <div className="ck-dc-foot">
        {options.map((o) => {
          const cls = `ck-dc-btn${o.tone === 'allow' && o.id === firstAllow ? ' ck-dc-btn--pri' : ''}${o.tone === 'deny' ? ' ck-dc-btn--no' : ''}`;
          if (o.tone === 'allow' && risky) {
            return (
              <HoldButton key={o.id} className={`${cls} ck-dc-btn--hold`} label={t('decision.holdLabel', { label: o.label })} onDone={() => answer(o.id, true)}>
                <span>{t('decision.hold', { label: o.label })}</span>
              </HoldButton>
            );
          }
          return (
            <button key={o.id} type="button" className={cls} data-role="answer" onClick={() => answer(o.id, o.tone === 'allow')}>
              {o.label}
            </button>
          );
        })}
        {rememberable && (
          <label className="ck-dc-sw" data-testid="decision-never">
            <input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} />
            <span className="ck-dc-track" aria-hidden="true" />
            <span>{t('decision.never')}</span>
          </label>
        )}
      </div>
      <button type="button" className="ck-dc-more ck-dc-dismiss" data-role="dismiss" onClick={onDismiss}>
        {t('decision.dismiss')}
      </button>
      {waiting > 0 && <div className="ck-dc-queue">{t('decision.moreWaiting', { n: waiting })}</div>}
    </div>
  );
}
