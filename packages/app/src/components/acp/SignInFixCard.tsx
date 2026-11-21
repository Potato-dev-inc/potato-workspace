// "<Agent>'s sign-in ended. Your message is kept." One card in the chat where the message failed.
// Sign in again opens the agent's own sign-in (as before; this card never sees a credential). While the person signs in the
// card tries the kept message again every few seconds, and the first time it goes through it is sent exactly once.
// Use <other agent> for this puts the kept words into a new chat with that agent, for the person to read and send.
//
// Without a terminal: when the chat can run the sign-in itself (`signIn`), the card is two steps, "1. Your browser opens. 2. Come
// back here.", and the agent's own sign-in runs in a hidden pane. Its terminal is folded under "Details" and opens by itself the
// moment the sign-in asks a question. The card closes the sign-in when the message goes through, and never sees a credential.
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import { useHost } from '../../lib/host/context';
import { onAnotherPc } from '../../lib/host/placeKey';
import type { ChatSignIn } from '../../lib/chatMore';
import { errorSentence } from '../../lib/sayError';
import { requestUsageRefresh } from '../../lib/usage';
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
  /** The sign-in without a terminal. Absent: "Sign in again" calls `onOpen`, which opens the agent's terminal as a pane. */
  signIn?: ChatSignIn;
  /** Draws the terminal of the hidden sign-in pane under Details. Defaults to the lend sheet's small terminal. */
  renderTerminal?: (paneId: string) => ReactNode;
  /** How often the sign-in is looked at (is it asking something?). */
  lookMs?: number;
  /** How often the kept message is tried while waiting for the sign-in. */
  pollMs?: number;
  /** After this long the card stops trying by itself and offers a button. */
  giveUpMs?: number;
  /** "Sign in again" with no chat (Usage card, Problems, Settings): no kept message, plainer words. */
  plain?: boolean;
  /** The first time the check goes through. */
  onSent?: () => void;
}

// The terminal (xterm) is loaded only when Details is opened.
const SignInTerminal = lazy(() => import('../lend/SignInTerminal').then((m) => ({ default: m.SignInTerminal })));

export const SIGNIN_POLL_MS = 6000;
export const SIGNIN_LOOK_MS = 1500;
export const SIGNIN_GIVE_UP_MS = 3 * 60_000;

type Step = 'ask' | 'waiting' | 'gaveUp' | 'sent' | 'cannotCheck';

const shorten = (text: string, max = 60): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export function SignInFixCard({ label, hint, kept, other, onOpen, onRetry, onUseOther, signIn, renderTerminal, lookMs = SIGNIN_LOOK_MS, pollMs = SIGNIN_POLL_MS, giveUpMs = SIGNIN_GIVE_UP_MS, plain = false, onSent }: SignInFixCardProps) {
  const t = useT();
  const host = useHost();
  const [step, setStep] = useState<Step>('ask');
  /** The hidden sign-in pane (without a terminal), its terminal under Details, and what the sign-in is doing. */
  const [hiddenPane, setHiddenPane] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [closedEarly, setClosedEarly] = useState(false);
  const signInRef = useRef(signIn);
  signInRef.current = signIn;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sentOnce = useRef(false);
  const trying = useRef(false);
  const onSentRef = useRef(onSent);
  onSentRef.current = onSent;
  const retryRef = useRef(onRetry);
  retryRef.current = onRetry;

  // One try. A refusal means "still signed out": keep waiting. The first success ends the waiting for good.
  const tryOnce = async (): Promise<boolean> => {
    if (sentOnce.current || trying.current) return sentOnce.current;
    trying.current = true;
    try {
      await retryRef.current();
      sentOnce.current = true;
      // A "still out" line from an earlier press of Try again is over now.
      setError(null);
      setStep('sent');
      // The sign-in is back: the Usage bar reads fresh numbers, so its "Sign-in expired" row clears.
      requestUsageRefresh();
      onSentRef.current?.();
      // The message went through: the sign-in worked, and its hidden pane is not needed any more.
      void signInRef.current?.stop().catch(() => undefined);
      setHiddenPane(null);
      return true;
    } catch (e) {
      // This agent shows no sign-in anywhere the app can look: stop promising, say so (the sheet's Close is the way out).
      if ((e as { name?: string })?.name === 'SignInCannotCheck') setStep('cannotCheck');
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

  // Without a terminal: look at the hidden sign-in. A question on its screen opens Details by itself, once; a pane that ended
  // before the message went through says so.
  useEffect(() => {
    if (!signIn || !hiddenPane || step !== 'waiting') return;
    let live = true;
    let askedBefore = false;
    const look = () =>
      signIn.status().then(
        (now) => {
          if (!live) return;
          if (!now.alive) {
            setClosedEarly(true);
            setHiddenPane(null);
            return;
          }
          setAsking(now.asking);
          if (now.asking && !askedBefore) {
            askedBefore = true;
            setDetailsOpen(true);
          }
        },
        () => undefined,
      );
    const timer = window.setInterval(() => void look(), lookMs);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [signIn, hiddenPane, step, lookMs]);

  // The card goes away (the chat closed, the message went): the hidden pane goes with it.
  useEffect(
    () => () => {
      void signInRef.current?.stop().catch(() => undefined);
    },
    [],
  );

  const signInAgain = async () => {
    setBusy(true);
    setError(null);
    setClosedEarly(false);
    try {
      if (signIn) {
        setHiddenPane(await signIn.start());
        setDetailsOpen(false);
        setAsking(false);
      } else {
        await onOpen();
      }
      setStep('waiting');
    } catch (e) {
      setError(errorSentence(e));
    } finally {
      setBusy(false);
    }
  };
  // "Try again" after the waiting ran out: look once more; when the sign-in is still not done, keep waiting for another round
  // (the hidden sign-in is still open) and say so. It never says "signed in" without a real sign.
  const sendNow = async () => {
    setError(null);
    if (await tryOnce()) return;
    setError(t('flow.signin.stillOut', { agent: label }));
    setStep((s) => (s === 'gaveUp' ? 'waiting' : s));
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
        <p className="ck-acp-card-title">{plain ? t('signin.again.title', { agent: label }) : t('flow.signin.title', { agent: label })}</p>
        <p className="ck-acp-card-line">
          {plain ? (step === 'sent' ? t('signin.again.done') : t('signin.again.lead')) : step === 'sent' ? t('flow.signin.sent') : t('flow.signin.kept')}
          {!plain && kept && step !== 'sent' && <> “{shorten(kept)}”</>}
        </p>
        {signIn && step === 'ask' && (
          <ol className="ck-acp-card-steps" data-testid="signin-steps">
            <li>{t(onAnotherPc(host.place) ? 'chat.signin.step1.far' : 'chat.signin.step1')}</li>
            <li>{t('chat.signin.step2')}</li>
          </ol>
        )}
        {step === 'waiting' && signIn && (
          <p className="ck-acp-card-line" role="status" data-testid="signin-working">
            {closedEarly ? t('chat.signin.closed') : asking ? t('chat.signin.asking') : plain ? t('signin.again.working') : t('chat.signin.working')}
          </p>
        )}
        {step === 'waiting' && !signIn && (
          <p className="ck-acp-card-line" role="status">
            {t('flow.signin.waiting')} {hint}
          </p>
        )}
        {signIn && hiddenPane && step === 'waiting' && (
          <details
            className="ck-acp-card-details"
            data-testid="signin-details"
            open={detailsOpen}
            onToggle={(event) => {
              const details = event.currentTarget as HTMLDetailsElement;
              setDetailsOpen(details.open);
              // The terminal is taller than the room under the text: bring all of it into view (the sheet scrolls).
              if (details.open) window.requestAnimationFrame(() => details.scrollIntoView?.({ block: 'nearest' }));
            }}
          >
            <summary>{t('chat.signin.details')}</summary>
            {detailsOpen && (renderTerminal ? renderTerminal(hiddenPane) : <Suspense fallback={null}><SignInTerminal paneId={hiddenPane} label={t('chat.signin.details')} /></Suspense>)}
          </details>
        )}
        {step === 'cannotCheck' && <p className="ck-acp-card-line" data-testid="signin-cannot-check">{t('signin.again.cannotCheck', { agent: label })}</p>}
        {step === 'gaveUp' && <p className="ck-acp-card-line">{plain ? t('signin.again.gaveUp') : t('flow.signin.gaveUp')}</p>}
        {error && (
          <p className="ck-acp-card-line is-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {step !== 'sent' && step !== 'cannotCheck' && (
        <div className="ck-acp-card-actions">
          {step === 'gaveUp' ? (
            <button type="button" className="ck-btn" onClick={() => void sendNow()}>
              {plain ? t('signin.again.check') : t('flow.signin.sendNow')}
            </button>
          ) : (
            <button type="button" className="ck-btn" disabled={busy} onClick={() => void signInAgain()}>
              {signIn ? (busy ? t('chat.signin.starting') : step === 'waiting' && !closedEarly ? t('flow.signin.openAgain') : t('chat.signin.start')) : step === 'waiting' ? t('flow.signin.openAgain') : t('flow.signin.again')}
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
