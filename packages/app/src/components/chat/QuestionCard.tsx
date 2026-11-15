// The agent asked the person a multiple-choice question (a `question` tool call). Options are buttons; the choice goes
// back to the agent as a message of this chat. Used by ToolRow, so the desktop chat and the phone draw the same card.
import { useState } from 'react';
import { useT } from '../../i18n';
import '../../styles/chat-agent-cards.css';
import { useChatAnswer } from './chatAnswer';
import { answerText, type AskQuestion } from './questionCall';

function OneQuestion({ ask }: { ask: AskQuestion }) {
  const t = useT();
  const send = useChatAnswer();
  const [picked, setPicked] = useState<string[]>([]);
  const [sent, setSent] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (choice: string[]) => {
    if (!send || choice.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    const failed = await send(answerText(ask, choice)).catch(() => t('chatUx.ask.failed'));
    setBusy(false);
    if (failed) setError(failed);
    else setSent(choice);
  };
  const toggle = (label: string) => setPicked((cur) => (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]));

  return (
    <div className="ck-qcard" data-testid="question-card">
      {ask.header && <span className="ck-caption ck-qcard-head">{ask.header}</span>}
      <p className="ck-qcard-q">{ask.question}</p>
      {sent ? (
        <p className="ck-qcard-done" data-testid="question-answered">{t('chatUx.ask.answered', { answer: sent.join(', ') })}</p>
      ) : (
        <>
          <ul className="ck-qcard-options" aria-label={ask.question}>
            {ask.options.map((o) => (
              <li key={o.label}>
                <button
                  type="button"
                  className={`ck-btn ck-qcard-opt${picked.includes(o.label) ? ' is-picked' : ''}`}
                  aria-pressed={ask.multiple ? picked.includes(o.label) : undefined}
                  disabled={!send || busy}
                  onClick={() => (ask.multiple ? toggle(o.label) : void submit([o.label]))}
                >
                  <span className="ck-qcard-opt-label">{o.label}</span>
                  {o.description && <span className="ck-qcard-opt-desc">{o.description}</span>}
                </button>
              </li>
            ))}
          </ul>
          {ask.multiple && send && (
            <button type="button" className="ck-btn ck-btn--primary ck-qcard-send" disabled={picked.length === 0 || busy} onClick={() => void submit(picked)}>
              {t('chatUx.ask.send')}
            </button>
          )}
          {error && <p className="ck-qcard-error" role="alert">{error}</p>}
        </>
      )}
    </div>
  );
}

export function QuestionCard({ questions }: { questions: readonly AskQuestion[] }) {
  return (
    <div className="ck-chat-row ck-agc-card ck-qcard-card">
      {questions.map((q) => (
        <OneQuestion key={q.question} ask={q} />
      ))}
    </div>
  );
}
