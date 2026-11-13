// A consent card in the Inbox: an agent wants to control a pane it did not start, or answer a risky
// prompt in one. It is a question Potato Workspace raised (see src-tauri/src/agent_authority), so it
// arrives through the same list as `ask_user` questions and is answered the same way. Deny comes
// first and is the primary button on purpose: the easy tap is the safe one. No number key answers it,
// and there is no lock-screen version.
import { useEffect, useRef } from 'react';
import { t, useT } from '../../i18n';
import type { Question, QuestionAnswer } from '../../lib/questions';
import { LEVEL_WORD } from '../../lib/approval-risk';
import { waitCaption } from '../../lib/questions';
import '../../styles/cockpit-questions.css';
import { CardButton, InboxCard, focusWithRing } from './InboxCard';

const UNKNOWN = 'Another agent';

/** "another agent" inside a sentence, a name as it is. */
const inSentence = (name: string): string => (name === UNKNOWN ? t('inboxCards.consent.anotherAgent') : name);

const NOT_STARTED = 'It did not start this pane.';

/** Who is asking, for the line next to the title: the name, or one plain phrase when Potato cannot name it. */
export function askerName(q: Question): string {
  const name = q.consent?.requester?.trim();
  return !name || name === UNKNOWN ? t('inboxCards.consent.unknownAgent') : name;
}

/**
 * The reason line. Answering a prompt quotes what is being answered, so it cannot read like an order:
 * "It wants to answer: "Delete a folder outside this project"." then "It did not start this pane."
 */
export function consentReason(q: Question): string | undefined {
  if (q.consent?.action !== 'answer_prompt') return q.context;
  const asked = (q.context ?? '').replace(NOT_STARTED, '').trim().replace(/[.:]+$/, '');
  return asked ? `${t('inboxCards.consent.wantsToAnswer', { asked })}
${t('inboxCards.consent.notStarted')}` : q.context;
}

/** The card's question in the pane's own name: "Allow Claude to control Codex 1?" */
export function consentTitle(q: Question, paneName?: string): string {
  const info = q.consent;
  if (!info) return q.question;
  const who = inSentence(info.requester || UNKNOWN);
  const target = paneName?.trim() || info.target || t('inboxCards.consent.thatWindow');
  return info.action === 'answer_prompt'
    ? t('inboxCards.consent.answerTitle', { who, target })
    : t('inboxCards.consent.controlTitle', { who, target });
}

export function ConsentCard({
  q,
  paneName,
  now,
  onAnswer,
  onOpenPane,
  autoFocus = false,
}: {
  q: Question;
  /** The target pane's name in the sidebar, when it is open. */
  paneName?: string;
  now: number;
  onAnswer: (answer: QuestionAnswer) => void;
  onOpenPane?: () => void;
  /** The first card in the Inbox: the keyboard starts on Deny. */
  autoFocus?: boolean;
}) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const has =(id: string) => q.choices.some((c) => c.id === id);
  useEffect(() => {
    if (!autoFocus) return;
    const active = document.activeElement;
    if (active && active !== document.body && /^(INPUT|TEXTAREA)$/.test(active.tagName)) return;
    focusWithRing(root.current?.querySelector<HTMLElement>('[data-choice="deny"]'));
  }, [autoFocus, q.id]);

  return (
    <div ref={root} className="ib-approval">
      <InboxCard
        kind="consent"
        agent={q.agent}
        glyph="needs"
        guard
        title={consentTitle(q, paneName)}
        age={now - q.created_at_ms}
        meta={askerName(q)}
        status={q.consent?.risk ? LEVEL_WORD[q.consent.risk] : null}
        risk={q.consent?.risk === 'high' ? 'high' : undefined}
        reason={consentReason(q)}
        note={<span data-testid="consent-wait">{waitCaption(q, now)}</span>}
        data={{ 'data-consent-id': q.id }}
        actions={
          <>
            {has('deny') && (
              <CardButton tone="primary" role="answer" data-choice="deny" onClick={() => onAnswer({ choice_id: 'deny' })}>
                {t('inboxCards.consent.deny')}
              </CardButton>
            )}
            {has('allow_once') && (
              <CardButton tone="secondary" role="answer" data-choice="allow_once" onClick={() => onAnswer({ choice_id: 'allow_once' })}>
                {t('inboxCards.consent.allowOnce')}
              </CardButton>
            )}
            {has('always') && (
              <CardButton tone="plain" role="answer" data-choice="always" onClick={() => onAnswer({ choice_id: 'always' })}>
                {t('inboxCards.consent.alwaysHere')}
              </CardButton>
            )}
          </>
        }
        more={
          onOpenPane ? (
            <CardButton tone="plain" role="open" onClick={onOpenPane}>
              {t('inboxCards.open')}
            </CardButton>
          ) : null
        }
      />
    </div>
  );
}
