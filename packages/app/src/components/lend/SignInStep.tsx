// The sign-in step of a lend profile. It never leaves the sheet: the sign-in runs in a small terminal INSIDE the step, on a
// hidden pane that belongs to the sheet (not in the sidebar, never selected), so the view stays on Settings and the draft
// stays on screen. The sign-in itself stays on this PC: only its state ("Signed in as ...") is read here, never its token.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import type { Account } from '../../lib/accounts';
import { errText, type LendApi, type SignInStatus } from '../../lib/lend';
import { SignInTerminal } from './SignInTerminal';
import '../../styles/lend.css';

export type SignInHow = 'signin' | 'existing' | 'key';

/** How often the sign-in is looked at while the terminal is open. */
export const POLL_MS = 1500;
/** The terminal folds away this long after the sign-in worked. */
export const FOLD_MS = 1000;
/** A sign-in nobody finishes is given up after this long (the hidden pane is stopped by the app at the same time). */
export const GIVE_UP_MS = 10 * 60_000;

type Phase = 'idle' | 'running' | 'done' | 'failed' | 'timeout';

export interface SignInStepProps {
  api: LendApi;
  agentId: string;
  agentName: string;
  /** Why a sign-in cannot be lent for this agent (then only a key is offered), or null. */
  noSignIn: string | null;
  how: SignInHow;
  onHow: (how: SignInHow) => void;
  /** The lend sign-in this profile uses ('' for none yet). */
  accountId: string;
  onAccount: (id: string) => void;
  /** Lend sign-ins of this agent that already exist. */
  accounts: Account[];
  /** The name a new lend sign-in gets. */
  newLabel: string;
  keyValue: string;
  onKeyValue: (v: string) => void;
  hasKey: boolean;
  removeKey: boolean;
  onRemoveKey: (v: boolean) => void;
  /** Whether the lend sign-in is signed in right now (never true for a key). */
  onSignedIn: (signedIn: boolean, identity: string | null) => void;
}

export function SignInStep(p: SignInStepProps) {
  const t = useT();
  const { api, agentId, how, accountId } = p;
  const [phase, setPhase] = useState<Phase>('idle');
  const [paneId, setPaneId] = useState<string | null>(null);
  const [showTerm, setShowTerm] = useState(false);
  const [identity, setIdentity] = useState<string | null>(null);
  const [outState, setOutState] = useState<SignInStatus['state'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef(0);
  // A sign-in is being started right now: an older "where does it stand" answer must not undo it.
  const starting = useRef(false);
  const live = useRef({ phase, accountId });
  live.current = { phase, accountId };
  const onSignedIn = useRef(p.onSignedIn);
  onSignedIn.current = p.onSignedIn;

  // The parent hears whether this sign-in can be lent right now.
  useEffect(() => {
    onSignedIn.current(how !== 'key' && phase === 'done', phase === 'done' ? identity : null);
  }, [how, phase, identity]);

  // A sign-in that was made before (a draft that came back, an account picked from the list): read where it stands.
  useEffect(() => {
    if (how === 'key' || !accountId || live.current.phase === 'running') return;
    let alive = true;
    setOutState(null);
    api
      .signInStatus(accountId)
      .then((st) => {
        if (!alive || live.current.phase === 'running' || starting.current) return;
        setOutState(st.state);
        setIdentity(st.identity);
        setPhase(st.state === 'signed_in' ? 'done' : 'idle');
      })
      .catch(() => alive && setPhase('idle'));
    return () => {
      alive = false;
    };
  }, [api, how, accountId]);

  // While the terminal is open, look at the sign-in every 1.5 s (and on `lend://changed`).
  useEffect(() => {
    if (phase !== 'running' || !accountId) return;
    let alive = true;
    const look = async () => {
      try {
        const st = await api.signInStatus(accountId);
        if (!alive) return;
        if (st.state === 'signed_in') {
          setIdentity(st.identity);
          setOutState('signed_in');
          setPhase('done');
        } else if (Date.now() - startedAt.current >= GIVE_UP_MS) {
          setPhase('timeout');
        } else if (!st.pane_alive) {
          setPhase('failed');
        }
      } catch {
        /* the next look tries again */
      }
    };
    const timer = window.setInterval(() => void look(), POLL_MS);
    let off: (() => void) | undefined;
    void api.onChanged(() => void look()).then((u) => (alive ? (off = u) : u()));
    return () => {
      alive = false;
      window.clearInterval(timer);
      off?.();
    };
  }, [api, phase, accountId]);

  // It worked: one more look for the name (the agent writes it a moment after the sign-in), then the terminal folds away
  // and the hidden pane is stopped. The sign-in stays.
  useEffect(() => {
    if (phase !== 'done' || !paneId || !accountId) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void api
        .signInStatus(accountId)
        .then((st) => alive && st.identity && setIdentity(st.identity))
        .catch(() => undefined)
        .finally(() => {
          if (!alive) return;
          setShowTerm(false);
          setPaneId(null);
          void api.signInStop(accountId, false).catch(() => undefined);
        });
    }, FOLD_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [api, phase, paneId, accountId]);

  // Leaving the step (closing the sheet, going back) stops the hidden pane; the account and the draft stay.
  const running = useRef<string | null>(null);
  running.current = paneId ? accountId : null;
  useEffect(
    () => () => {
      if (running.current) void api.signInStop(running.current, false).catch(() => undefined);
    },
    [api],
  );

  const begin = useCallback(
    async (forceNew = false) => {
      starting.current = true;
      setBusy(true);
      setError(null);
      try {
        let id = accountId;
        if (p.how === 'signin') {
          const made = await api.accountAdd(agentId, p.newLabel, forceNew ? null : accountId || null);
          id = made.id;
          if (id !== accountId) p.onAccount(id);
        }
        if (!id) return;
        const started = await api.signInStart(id);
        startedAt.current = Date.now();
        setPaneId(started.pane_id);
        setShowTerm(true);
        setIdentity(null);
        setPhase('running');
      } catch (err) {
        setError(errText(err));
      } finally {
        starting.current = false;
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, agentId, accountId, p.how, p.newLabel],
  );

  const stopPane = async (removeIfEmpty: boolean): Promise<boolean> => {
    if (!accountId) return false;
    try {
      return await api.signInStop(accountId, removeIfEmpty);
    } catch (err) {
      setError(errText(err));
      return false;
    }
  };

  const restart = async () => {
    await stopPane(false);
    setPaneId(null);
    await begin();
  };

  const cancel = async () => {
    const removed = await stopPane(true);
    setPaneId(null);
    setShowTerm(false);
    setPhase('idle');
    setOutState(null);
    if (removed) p.onAccount('');
  };

  const another = async () => {
    await stopPane(false);
    setPaneId(null);
    setPhase('idle');
    await begin(true);
  };

  const choose = (h: SignInHow) => {
    if (h === how) return;
    if (phase === 'running') void cancel();
    p.onHow(h);
  };

  const card = (h: SignInHow, title: string, sub: string | null) => (
    <label className="lend-card" data-on={how === h ? 'true' : undefined}>
      <input type="radio" name="lend-how" checked={how === h} onChange={() => choose(h)} />
      <span className="lend-card-text">
        <strong>{title}</strong>
        {sub && <small>{sub}</small>}
      </span>
    </label>
  );

  const signedLine = (
    <p className="lend-signed" role="status">
      <span aria-hidden="true">✓ </span>
      {identity ? t('lend.signin.doneAs', { who: identity }) : t('lend.signin.done')}
    </p>
  );

  return (
    <div className="lend-signin" data-phase={phase}>
      <h3 className="lend-step-title">{t('lend.signin.title', { agent: p.agentName })}</h3>
      <p className="lend-muted">{t('lend.signin.lead')}</p>
      {p.noSignIn && (
        <p className="lend-note" role="status" data-testid="lend-signin-not-yet">
          {p.noSignIn}
        </p>
      )}
      <div className="lend-cards" role="radiogroup" aria-label={t('lend.signIn')}>
        {!p.noSignIn && card('signin', t('lend.signin.account'), t('lend.signin.accountSub'))}
        {!p.noSignIn && p.accounts.length > 0 && card('existing', t('lend.signin.existing'), null)}
        {card('key', t('lend.pasteKey'), t('lend.signin.keySub'))}
      </div>

      {how === 'existing' && (
        <label className="lend-field">
          <span>{t('lend.lendSignIn')}</span>
          <select aria-label={t('lend.lendSignIn')} value={accountId} onChange={(e) => p.onAccount(e.target.value)}>
            <option value="" disabled>
              {t('lend.signin.pickPlaceholder')}
            </option>
            {p.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {how !== 'key' && (
        <div className="lend-signin-body">
          {phase === 'idle' && (how === 'signin' || accountId) && (
            <div className="lend-row">
              {outState && outState !== 'signed_in' && <span className="lend-muted">{t('lend.signin.out')}</span>}
              {!outState && !accountId && <span className="lend-muted">{t('lend.signin.none')}</span>}
              <button type="button" className="lend-btn is-primary" disabled={busy} onClick={() => void begin()}>
                {t('lend.signin.go')}
              </button>
            </div>
          )}
          {phase === 'running' && (
            <>
              <p className="lend-muted">{t('lend.signin.follow')}</p>
              {paneId && showTerm && <SignInTerminal paneId={paneId} label={t('lend.signin.termAria')} />}
              <p className="lend-waiting" role="status" aria-live="polite">
                <span className="lend-dots" aria-hidden="true" /> {t('lend.signin.waiting')}
              </p>
              <p className="lend-muted lend-small">{t('lend.signin.noBrowser')}</p>
              <div className="lend-row">
                <button type="button" className="lend-btn is-plain is-small" disabled={busy} onClick={() => void restart()}>
                  {t('lend.signin.restart')}
                </button>
                <button type="button" className="lend-btn is-plain is-small" disabled={busy} onClick={() => void cancel()}>
                  {t('lend.signin.cancel')}
                </button>
              </div>
            </>
          )}
          {phase === 'done' && (
            <>
              {paneId && showTerm && <SignInTerminal paneId={paneId} label={t('lend.signin.termAria')} />}
              <div className="lend-row">
                {signedLine}
                <button type="button" className="lend-btn is-plain is-small" disabled={busy} onClick={() => void another()}>
                  {t('lend.signin.another')}
                </button>
              </div>
            </>
          )}
          {(phase === 'failed' || phase === 'timeout') && (
            <>
              {paneId && showTerm && phase === 'failed' && <SignInTerminal paneId={paneId} label={t('lend.signin.termAria')} />}
              <p className="lend-error" role="alert">
                {phase === 'timeout' ? t('lend.signin.timeout') : t('lend.signin.failed')}
              </p>
              <div className="lend-row">
                <button type="button" className="lend-btn is-primary" disabled={busy} onClick={() => void restart()}>
                  {t('lend.signin.tryAgain')}
                </button>
                {phase === 'failed' && (
                  <button
                    type="button"
                    className="lend-btn is-plain"
                    onClick={() => {
                      void cancel();
                      p.onHow('key');
                    }}
                  >
                    {t('lend.signin.useKey')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {how === 'key' && (
        <div className="lend-signin-body">
          <label className="lend-field">
            <span>{t('lend.pasteKey')}</span>
            <input
              type="password"
              aria-label={t('lend.apiKey')}
              autoComplete="off"
              value={p.keyValue}
              placeholder={p.hasKey && !p.removeKey ? t('lend.keySaved') : t('lend.keyHere')}
              onChange={(e) => p.onKeyValue(e.target.value)}
            />
          </label>
          {p.hasKey && !p.removeKey && p.keyValue.trim() === '' && (
            <p className="lend-signed" role="status">
              <span aria-hidden="true">✓ </span>
              {t('lend.signin.keySaved')}
            </p>
          )}
          {p.hasKey && (
            <label className="lend-radio">
              <input type="checkbox" checked={p.removeKey} onChange={(e) => p.onRemoveKey(e.target.checked)} />
              <span>{t('lend.removeKey')}</span>
            </label>
          )}
        </div>
      )}
      {error && (
        <p className="lend-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
