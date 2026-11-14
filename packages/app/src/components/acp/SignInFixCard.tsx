// "<Agent>'s sign-in ended. Your message is kept." One card in the chat where the message failed.
// Sign in again opens the agent's own sign-in (as before; this card never sees a credential). While the person signs in the
// card tries the kept message again every few seconds, and the first time it goes through it is sent exactly once.
// Use <other agent> for this puts the kept words into a new chat with that agent, for the person to read and send.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import '../../styles/cockpit-acp.css';

export interface SignInFixCardProps {
  /** The agent's name ("Claude"). */
  label: string;
  /** What to do in the sign-in terminal (from the agent's table); shown under the buttons while waiting. */
  hint?: string;
  /** The kept message, or empty when the backend did not say. Shown short, never edited. */
  kept?: string | null;
  /** Another agent that can take this message, or null when there is none. */
  other: { id: string; label: string } | null;
  /** Opens the agent's own sign-in. */
  onOpen: () => Promise<unknown> | void;
  /** Sends the kept message. Rejects with a plain sentence while the agent still wants a sign-in. */
  onRetry: () => Promise<unknown> | void;
  /** Starts a chat with the other agent and puts the kept words in its message box. */
  onUseOther: (id: string, kept: string) => Promise<unknown> | void;
  /** How often the kept message is tried while waiting for the sign-in. */
  pollMs?: number;
  /** After this long the card stops trying by itself and offers a button. */
  giveUpMs?: number;
}

export const SIGNIN_POLL_MS = 6000;
export const SIGNIN_GIVE_UP_MS = 3 * 60_000;

type Step = 'ask' | 'waiting' | 'gaveUp' | 'sent';

const shorten = (text: string, max = 60): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export function SignInFixCard({ label, hint, kept, other, onOpen, onRetry, onUseOther, pollMs = SIGNIN_POLL_MS, giveUpMs = SIGNIN_GIVE_UP_MS }: SignInFixCardProps) {
  const t = useT();
  const [step, setStep] = useState<Step>('ask');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sentOnce = useRef(false);
  const trying = useRef(false);
  const retryRef = useRef(onRetry);
  retryRef.current = onRetry;

  // One try. A refusal means "still signed out": keep waiting. The first success ends the waiting for good.
  const tryOnce = async (): Promise<boolean> => {
    if (sentOnce.current || trying.current) return sentOnce.current;
    trying.current = true;
    try {
      await retryRef.current();
      sentOnce.current = true;
      setStep('sent');
      return true;
    } catch {
      return false;
    } finally {
      trying.current = false;
    }
  };

  useEffect(() => {
    if (step !== 'waiting') return;
    const poll = window.setInterval(() => void tryOnce(), pollMs);
    const stop = window.setTimeout(() => setStep((s) => (s === 'waiting' ? 'gaveUp' : s)), giveUpMs);
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(stop);
    };
    // tryOnce reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, pollMs, giveUpMs]);

  const signInAgain = async () => {
    setBusy(true);
    setError(null);
    try {
      await onOpen();
      setStep('waiting');
    } catch (e) {
      setError(errorSentence(e));
    } finally {
      setBusy(false);
    }
  };
  const sendNow = async () => {
    setError(null);
    if (!(await tryOnce())) setError(t('flow.signin.stillOut', { agent: label }));
  };
  const useOther = async () => {
    if (!other) return;
    setBusy(true);
    setError(null);
    try {
      await onUseOther(other.id, kept ?? '');
    } catch (e) {
      setError(errorSentence(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ck-acp-card" data-testid="signin-fix-card" role="group" aria-label={t('flow.signin.title', { agent: label })}>
      <div className="ck-acp-card-body">
        <p className="ck-acp-card-title">{t('flow.signin.title', { agent: label })}</p>
        <p className="ck-acp-card-line">
          {step === 'sent' ? t('flow.signin.sent') : t('flow.signin.kept')}
          {kept && step !== 'sent' && <> “{shorten(kept)}”</>}
        </p>
        {step === 'waiting' && (
          <p className="ck-acp-card-line" role="status">
            {t('flow.signin.waiting')} {hint}
          </p>
        )}
        {step === 'gaveUp' && <p className="ck-acp-card-line">{t('flow.signin.gaveUp')}</p>}
        {error && (
          <p className="ck-acp-card-line is-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {step !== 'sent' && (
        <div className="ck-acp-card-actions">
          {step === 'gaveUp' ? (
            <button type="button" className="ck-btn" onClick={() => void sendNow()}>
              {t('flow.signin.sendNow')}
            </button>
          ) : (
            <button type="button" className="ck-btn" disabled={busy} onClick={() => void signInAgain()}>
              {step === 'waiting' ? t('flow.signin.openAgain') : t('flow.signin.again')}
            </button>
          )}
          {other && (
            <button type="button" className="ck-btn ck-btn--secondary" disabled={busy} onClick={() => void useOther()}>
              {t('flow.signin.useOther', { agent: other.label })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
