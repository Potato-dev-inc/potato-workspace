// The small sheet of "Sign in again" (Usage card, Problems, Settings). It is the lend sign-in's two steps ("Your browser
// opens. Come back here.", the sign-in's terminal folded under Details) in a sheet over the screen the person is on. The
// sign-in runs in a hidden pane, so nothing new appears in the sidebar and no terminal opens in the workspace.
import { useMemo, useRef } from 'react';
import { useT } from '../../i18n';
import { closeSignInAgain, desktopAgentSignIn, signedInNow, useSignInAgain } from '../../lib/agentSignIn';
import type { ChatSignIn } from '../../lib/chatMore';
import { SignInFixCard } from '../acp/SignInFixCard';
import { LendSheet } from '../lend/LendSheet';

export interface SignInAgainHostProps {
  /** Tests give a fake pane driver. */
  driver?: (agentId: string, accountId?: string | null) => ChatSignIn;
  /** Tests give a fake "is it signed in yet". Rejects while it is not. */
  check?: (agentId: string, accountId?: string | null) => Promise<void>;
  lookMs?: number;
  pollMs?: number;
  /** How long the sheet stays after "Signed in" before it closes by itself. */
  closeMs?: number;
}

export function SignInAgainHost({ driver = desktopAgentSignIn, check = signedInNow, lookMs, pollMs, closeMs = 1600 }: SignInAgainHostProps) {
  const req = useSignInAgain();
  if (!req) return null;
  return <Sheet key={`${req.agentId}:${req.accountId ?? ''}`} req={req} driver={driver} check={check} lookMs={lookMs} pollMs={pollMs} closeMs={closeMs} />;
}

function Sheet({ req, driver, check, lookMs, pollMs, closeMs }: SignInAgainHostProps & { req: NonNullable<ReturnType<typeof useSignInAgain>>; driver: NonNullable<SignInAgainHostProps['driver']>; check: NonNullable<SignInAgainHostProps['check']>; closeMs: number }) {
  const t = useT();
  const signIn = useMemo(() => driver(req.agentId, req.accountId), [driver, req.agentId, req.accountId]);
  const timer = useRef<number | undefined>(undefined);
  return (
    <LendSheet title={t('signin.again.row')} labelledBy="signin-again-title" onClose={closeSignInAgain}>
      <div data-testid="signin-again-sheet">
        <SignInFixCard
          plain
          label={req.label}
          other={null}
          onOpen={() => undefined}
          onUseOther={() => undefined}
          onRetry={() => check(req.agentId, req.accountId)}
          signIn={signIn}
          lookMs={lookMs}
          pollMs={pollMs}
          onSent={() => {
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(closeSignInAgain, closeMs);
          }}
        />
        <div className="lend-actions">
          <button type="button" className="ck-btn ck-btn--secondary" onClick={closeSignInAgain}>
            {t('signin.again.close')}
          </button>
        </div>
      </div>
    </LendSheet>
  );
}
