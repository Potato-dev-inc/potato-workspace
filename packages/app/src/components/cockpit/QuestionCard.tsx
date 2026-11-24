// One `ask_user` question in the Inbox: the agent's question, its choices as buttons, a text field
// when free text is allowed, and Dismiss. It is an InboxCard like every other card.
import { useState } from 'react';
import { useT } from '../../i18n';
import {
  askerName,
  helperLoginChoice,
  helperLoginOptions,
  permissionAsk,
  isHelperLogin,
  waitCaption,
  type Question,
  type QuestionAnswer,
} from '../../lib/questions';
import { optionWords } from '../../lib/decisionCard';
import { ACP_PERMISSION_KIND } from '../../lib/acpChat';
import { SIGN_IN } from '../../lib/glossary';
import '../../styles/cockpit-questions.css';
import { CardButton, InboxCard } from './InboxCard';

/** "Write notes.txt" reads as "... wants to write notes.txt"; a name like "MCP tool" keeps its capitals. */
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

export function QuestionCard({
  q,
  paneName,
  now,
  onAnswer,
  onDismiss,
  onOpenPane,
  onAddLogin,
}: {
  q: Question;
  /** A helper-login card: opens Settings on the accounts, where another login can be added. */
  onAddLogin?: () => void;
  /** Name of the pane the question belongs to, when it names one. */
  paneName?: string;
  now: number;
  onAnswer: (answer: QuestionAnswer) => void;
  /** Dismiss CANCELS the question (an agent start then starts nothing). Absent: no Dismiss button (the jump-out card). */
  onDismiss?: () => void;
  onOpenPane?: () => void;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [always, setAlways] = useState(false);
  const helper = isHelperLogin(q);
  const perm = permissionAsk(q);
  const send = () => {
    const value = text.trim();
    if (!value) return;
    onAnswer({ text: value });
    setText('');
  };

  return (
    <InboxCard
      kind="question"
      agent={q.agent}
      glyph="needs"
      permission={perm !== null}
      title={perm ? t('inboxCards.question.wants', { who: perm.who, action: (/^[!-~]/.test(perm.action) ? t('inboxCards.question.gap') : '') + lowerFirst(perm.action) }) : q.question}
      meta={perm ? perm.who : askerName(q, paneName)}
      age={now - q.created_at_ms}
      reason={q.context}
      snoozeKeys={helper ? undefined : [`q-${q.id}`]}
      note={<span data-testid="question-wait">{waitCaption(q, now, paneName)}</span>}
      data={{ 'data-question-id': q.id, 'data-urgent': q.urgency === 'high' ? '' : undefined }}
      body={
        helper ? (
          <label className="ib-check" data-testid="helper-always">
            <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
            <span>{t('inboxCards.question.alwaysUse')}</span>
          </label>
        ) : q.allow_free_text ? (
          <form
            className="ib-field"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={q.choices.length > 0 ? t('inboxCards.question.orType') : t('inboxCards.question.typeAnswer')}
              aria-label={t('inboxCards.question.yourAnswer')}
              maxLength={4000}
            />
            <button type="submit" className="ck-btn ck-btn--secondary" disabled={!text.trim()}>
              {t('inboxCards.send')}
            </button>
          </form>
        ) : null
      }
      actions={
        helper ? (
          <>
            {helperLoginOptions(q).map((o) => (
              <CardButton key={o.id} tone="secondary" role="answer" onClick={() => onAnswer({ choice_id: helperLoginChoice(o.id, always) })}>
                {o.label}
              </CardButton>
            ))}
          </>
        ) : q.choices.length > 0 ? (
          // Equal weight on purpose: the agent wrote the choices, so none is made the easy default.
          <>
            {q.choices.map((c) => (
              <CardButton key={c.id} tone="secondary" role="answer" onClick={() => onAnswer({ choice_id: c.id })}>
                {q.kind === ACP_PERMISSION_KIND ? optionWords(c.id, c.label) : c.label}
              </CardButton>
            ))}
          </>
        ) : null
      }
      more={
        <>
          {helper && onAddLogin && (
            <CardButton tone="plain" onClick={onAddLogin}>
              {SIGN_IN.addAnother}
            </CardButton>
          )}
          {onDismiss && (
            <CardButton tone="plain" role="dismiss" onClick={onDismiss}>
              {t('inboxCards.dismiss')}
            </CardButton>
          )}
          {onOpenPane && (
            <CardButton tone="plain" role="open" onClick={onOpenPane}>
              {t('inboxCards.open')}
            </CardButton>
          )}
        </>
      }
    />
  );
}
