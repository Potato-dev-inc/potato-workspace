// The sign-in terminal INSIDE an agent's card: always visible while the person signs in (no fold-out), full size, and the card
// flips to Signed in by itself when the real proof arrives (`signedInNow`: this login's credential file written since the
// start, or a real usage reading). It never sees a credential. The hidden pane is stopped on Close and when the proof comes.
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useT } from '../../../i18n';
import { SIGNIN_GIVE_UP_MS, SIGNIN_LOOK_MS, SIGNIN_POLL_MS } from '../../acp/SignInFixCard';
import type { ChatSignIn } from '../../../lib/chatMore';
import { Btn } from '../settings-ui';

const SignInTerminal = lazy(() => import('../../lend/SignInTerminal').then((m) => ({ default: m.SignInTerminal })));

type Step = 'waiting' | 'done' | 'gaveUp' | 'cannotCheck';

export function CardSignIn({
  agentId,
  label,
  paneId,
  signIn,
  check,
  onSignedIn,
  onClose,
  pollMs = SIGNIN_POLL_MS,
  lookMs = SIGNIN_LOOK_MS,
  giveUpMs = SIGNIN_GIVE_UP_MS,
}: {
  agentId: string;
  label: string;
  paneId: string;
  signIn: ChatSignIn;
  /** Rejects with a plain sentence while the sign-in is not finished (`signedInNow`). */
  check: () => Promise<void>;
  onSignedIn: () => void;
  onClose: () => void;
  pollMs?: number;
  lookMs?: number;
  giveUpMs?: number;
}) {
  const t = useT();
  const [step, setStep] = useState<Step>('waiting');
  const [asking, setAsking] = useState(false);
  const [closedEarly, setClosedEarly] = useState(false);
  const [stillOut, setStillOut] = useState(false);
  const checking = useRef(false);
  const finished = useRef(false);
  const gone = useRef(false);
  const signInRef = useRef(signIn);
  signInRef.current = signIn;
  const checkRef = useRef(check);
  checkRef.current = check;
  const signedRef = useRef(onSignedIn);
  signedRef.current = onSignedIn;

  const tryOnce = async (): Promise<boolean> => {
    if (finished.current || checking.current) return finished.current;
    checking.current = true;
    try {
      await checkRef.current();
      finished.current = true;
      setStep('done');
      void signInRef.current.stop().catch(() => undefined);
      signedRef.current();
      return true;
    } catch (e) {
      if ((e as { name?: string })?.name === 'SignInCannotCheck') setStep('cannotCheck');
      return false;
    } finally {
      checking.current = false;
    }
  };

  useEffect(() => {
    if (step !== 'waiting') return undefined;
    const poll = window.setInterval(() => void tryOnce(), pollMs);
    const stop = window.setTimeout(() => setStep((s) => (s === 'waiting' ? 'gaveUp' : s)), giveUpMs);
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(stop);
    };
    // tryOnce reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, pollMs, giveUpMs]);

  // Is the sign-in asking something, did its pane end early.
  useEffect(() => {
    if (step !== 'waiting' || closedEarly) return undefined;
    let live = true;
    const timer = window.setInterval(() => {
      signIn.status().then(
        (now) => {
          if (!live) return;
          if (!now.alive) setClosedEarly(true);
          else setAsking(now.asking);
        },
        () => undefined,
      );
    }, lookMs);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [signIn, step, lookMs, closedEarly]);

  // The card goes away: the pane goes with it. StrictMode runs cleanup and mount at once, so stop a tick later and only if still gone.
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      window.setTimeout(() => {
        if (gone.current) void signInRef.current.stop().catch(() => undefined);
      }, 0);
    };
  }, []);

  const close = () => {
    void signIn.stop().catch(() => undefined);
    onClose();
  };
  const line =
    step === 'done'
      ? t('signin.again.done')
      : step === 'cannotCheck'
        ? t('signin.again.cannotCheck', { agent: label })
        : step === 'gaveUp'
          ? t('signin.again.gaveUp')
          : closedEarly
            ? t('chat.signin.closed')
            : asking
              ? t('agentCard.term.asking')
              : t('agentCard.term.working');
  return (
    <div className="ag-card-signin" data-testid={`card-signin-panel-${agentId}`}>
      <p className="ag-card-signin-line" role="status">
        {line}
      </p>
      {step !== 'done' && (
        <Suspense fallback={null}>
          <SignInTerminal paneId={paneId} label={t('agentCard.term.aria', { label })} />
        </Suspense>
      )}
      {stillOut && step === 'gaveUp' && <p className="ag-card-signin-line">{t('flow.signin.stillOut', { agent: label })}</p>}
      <div className="ag-card-actions">
        {step === 'gaveUp' && (
          <Btn small onClick={() => void tryOnce().then((ok) => setStillOut(!ok))}>
            {t('signin.again.check')}
          </Btn>
        )}
        <Btn small data-testid={`card-signin-close-${agentId}`} onClick={close}>
          {t('signin.again.close')}
        </Btn>
      </div>
    </div>
  );
}
