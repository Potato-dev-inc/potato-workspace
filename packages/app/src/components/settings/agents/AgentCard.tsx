// One agent's own card in Settings > Agents: mark and name, how it stands, which sign-in it uses, usage if the app already
// has it, and the buttons Sign in / Sign out. Sign out uses the existing `accounts_sign_out` (removes the account's declared
// sign-in files only; the backend refuses links and the agent's own folder). Clicking the name opens the agent's page.
import { useEffect, useMemo, useState } from 'react';
import { useT } from '../../../i18n';
import { accountsFor, tauriAccountsApi, type Account, type AccountsApi } from '../../../lib/accounts';
import { terminalOnly } from '../../../lib/agentCaps';
import { desktopAgentSignIn, signInFor, signedInNow } from '../../../lib/agentSignIn';
import type { Host } from '../../../lib/host/host';
import type { ChatSignIn } from '../../../lib/chatMore';
import { errorSentence } from '../../../lib/sayError';
import { headline, requestUsageRefresh, usageApi, type UsageApi, type UsageRow } from '../../../lib/usage';
import { AgentLogo } from '../../common/AgentLogo';
import { Btn, Note } from '../settings-ui';
import { openAddAgentWith } from './agentTarget';
import { CapChips } from './CapChips';
import { CardSignIn } from './CardSignIn';
import { ownLoginApi, ownLoginApiFor, ownSignedState, type OwnLogin } from './ownSignIn';
import { nextStep, standingWords, type AgentRow } from './useAgentRows';

export interface CardApis {
  accounts: AccountsApi;
  usage: UsageApi;
  /** How each agent's own login stands. Absent (tests, no desktop): every card says it cannot tell. */
  logins?: (fresh?: boolean) => Promise<OwnLogin[]>;
  /** The hidden sign-in pane of an agent (and account); tests give a fake. */
  signIn?: (agentId: string, accountId?: string | null) => ChatSignIn;
  /** Whether the sign-in is really done (rejects while it is not); tests give a fake. */
  check?: (agentId: string, accountId?: string | null) => Promise<void>;
  /** How often the card looks for the proof (tests make it short). */
  pollMs?: number;
}
export const defaultCardApis: CardApis = { accounts: tauriAccountsApi, usage: usageApi, logins: ownLoginApi.states, signIn: desktopAgentSignIn, check: signedInNow };

const noAccounts: AccountsApi = {
  list: async () => ({ accounts: [], borrowed: [] }) as unknown as Awaited<ReturnType<AccountsApi['list']>>,
  add: () => Promise.reject(new Error('not here')),
  rename: () => Promise.reject(new Error('not here')),
  remove: () => Promise.reject(new Error('not here')),
  signOut: async () => 0,
  openLoginPane: () => Promise.reject(new Error('not here')),
  setHelperLogin: () => Promise.reject(new Error('not here')),
};
const noUsage: UsageApi = { snapshot: async () => ({ rows: [] }) as never, openPage: async () => undefined, onChanged: async () => () => undefined };

/**
 * The card's sources at one place. This PC: as always. Another PC: its own login states and its own sign-in, and nothing of this PC's
 * (its extra accounts and usage numbers are not served there yet, so the card shows only the far agent's own state and never this PC's).
 */
export function cardApisFor(host: Host): CardApis {
  if (host.place.kind === 'local') return defaultCardApis;
  const { signIn, check } = signInFor(host);
  return { accounts: noAccounts, usage: noUsage, logins: ownLoginApiFor(host).states, signIn, check };
}

/** My extra sign-ins and the usage rows. Each source fails on its own (no desktop shell: the card just shows less). */
export function useCardData(apis: CardApis) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [logins, setLogins] = useState<OwnLogin[] | null>(null);
  /** `fresh`: right after a sign-in, so nothing old is reused. */
  const refresh = (fresh = false) => {
    apis.accounts
      .list()
      .then((o) => setAccounts(o.accounts))
      .catch(() => undefined);
    apis.logins?.(fresh).then(setLogins).catch(() => undefined);
    if (fresh) apis.usage.snapshot(true, true).then((s) => setUsage(s.rows)).catch(() => undefined);
  };
  useEffect(() => {
    refresh();
    apis.usage
      .snapshot(false, false)
      .then((s) => setUsage(s.rows))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apis]);
  return { accounts, usage, logins, refresh };
}

export function AgentCard({
  row,
  accounts,
  usage,
  logins,
  apis,
  signOut,
  onOpen,
  onCheck,
  onChanged,
}: {
  row: AgentRow;
  accounts: Account[];
  usage: UsageRow[];
  logins: OwnLogin[] | null;
  apis: CardApis;
  signOut: AccountsApi['signOut'];
  onOpen: (agentId: string) => void;
  onCheck?: (agentId: string) => Promise<void>;
  /** The card changed something (a sign-out, a finished sign-in): read the lists again. `fresh` after a sign-in. */
  onChanged: (fresh?: boolean) => void;
}) {
  const t = useT();
  const cli = row.caps !== null && terminalOnly(row.caps);
  const step = nextStep(row);
  // The sign-in a Sign out can act on: my first extra account for this agent (never a lend or borrowed one).
  const account = accountsFor(accounts, row.id).filter((a) => !a.lend_only && !a.borrowed)[0];
  const accountState = account?.login_state;
  const used = usage.find((u) => u.agent_id === row.id && (u.account_id ?? null) === (account?.id ?? null) && !u.link);
  const window0 = used && (used.state === 'ok' || used.state === 'limited') ? headline(used) : undefined;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  /** The sign-in terminal on this card: the hidden pane's id once it started. */
  const [session, setSession] = useState<{ paneId: string | null } | null>(null);
  const makeSignIn = apis.signIn ?? desktopAgentSignIn;
  const signIn = useMemo(() => makeSignIn(row.id, account?.id), [makeSignIn, row.id, account?.id]);
  const own = ownSignedState(row, logins, usage);

  const startSignIn = async () => {
    setMessage(null);
    setSession({ paneId: null });
    try {
      setSession({ paneId: await signIn.start() });
    } catch (err) {
      setSession(null);
      setMessage({ text: errorSentence(err), error: true });
    }
  };
  const who = account?.label ?? row.label;

  const doSignOut = async () => {
    if (!account) return;
    setAsking(false);
    setBusy(true);
    try {
      const removed = await signOut(account.id);
      setMessage({ text: t(removed === 0 ? 'accounts.signOutNothing' : 'accounts.signedOut', { label: account.label }), error: false });
      onChanged();
    } catch (err) {
      setMessage({ text: errorSentence(err), error: true });
    } finally {
      setBusy(false);
    }
  };

  const signOutOff = !account || busy || accountState === 'signed_out' || accountState === 'unknown';
  const stateWords = accountState === 'signed_in' ? ` · ${t('accounts.stateIn')}` : accountState === 'signed_out' ? ` · ${t('accounts.stateOut')}` : '';
  return (
    <section className="ag-card" data-testid={`agent-row-${row.id}`} data-agent={row.id} data-installed={row.installed ? 'true' : 'false'} data-signin={session ? 'open' : undefined} aria-label={row.label}>
      <button type="button" className="ag-open" aria-label={t('agentList.openAria', { label: row.label, standing: standingWords(row) })} onClick={() => onOpen(row.id)}>
        <span className="ag-mark ag-card-mark">
          <AgentLogo id={row.id} name={row.label} size={28} decorative />
        </span>
        <span className="ag-main">
          <span className="ag-name">{row.label}</span>
          <span className="ag-standing" data-state={row.state}>
            {standingWords(row)}
            {cli ? ` · ${t('agentList.terminalOnly')}` : ''}
          </span>
        </span>
        <span className="ag-go" aria-hidden="true">
          ›
        </span>
      </button>
      {row.installed && row.state !== 'not_installed' && (
        <dl className="ag-card-facts">
          <div>
            <dt>{t('agentCard.signIn')}</dt>
            <dd data-testid={`card-state-${row.id}`} data-state={own.kind}>
              {t(own.kind === 'in' ? 'agentCard.signedIn' : own.kind === 'out' ? 'agentCard.signedOut' : 'agentCard.cantTell')}
              {own.why ? <small className="ag-card-state-why">{own.why}</small> : null}
            </dd>
          </div>
          <div>
            <dt>{t('agentCard.account')}</dt>
            <dd data-testid={`card-account-${row.id}`}>{account ? `${account.label}${stateWords}` : t('agentCard.ownSignIn')}</dd>
          </div>
          {window0 && (
            <div>
              <dt>{t('agentCard.usage')}</dt>
              <dd data-testid={`card-usage-${row.id}`}>{t('agentCard.usedPercent', { name: window0.name, percent: Math.round(window0.used_percent) })}</dd>
            </div>
          )}
        </dl>
      )}
      {row.caps && !cli && (
        <div className="ag-card-chips">
          <CapChips caps={row.caps} name={row.label} compact />
        </div>
      )}
      <div className="ag-card-actions">
        {!row.installed || row.state === 'not_installed' ? (
          <Btn small className="ag-step" aria-label={t('agentList.stepAria', { step: t('agentList.step.install'), label: row.label })} onClick={() => openAddAgentWith(row.label)}>
            {t('agentList.step.install')}
          </Btn>
        ) : (
          <>
            <Btn
              small
              primary={own.kind === 'out' || row.state === 'needs_login'}
              disabled={session !== null}
              className="ag-step"
              data-testid={`card-signin-${row.id}`}
              aria-label={t('agentList.stepAria', { step: t('agentList.step.signin'), label: row.label })}
              onClick={() => void startSignIn()}
            >
              {t('agentList.step.signin')}
            </Btn>
            {asking ? (
              <span className="ag-card-ask" role="group" aria-label={t('accounts.signOutAsk', { label: who })}>
                <span>{t('accounts.signOutAsk', { label: who })}</span>
                <Btn small disabled={busy} data-testid={`card-signout-yes-${row.id}`} onClick={() => void doSignOut()}>
                  {t('accounts.signOutYes')}
                </Btn>
                <Btn small onClick={() => setAsking(false)}>
                  {t('accounts.signOutNo')}
                </Btn>
              </span>
            ) : (
              <Btn
                small
                disabled={signOutOff}
                title={account ? t('accounts.signOutTip') : t('agentCard.signOutOwn')}
                aria-label={t('agentCard.signOutAria', { label: row.label })}
                data-testid={`card-signout-${row.id}`}
                onClick={() => setAsking(true)}
              >
                {t('accounts.signOut')}
              </Btn>
            )}
            {step?.kind === 'check' && (
              <Btn small disabled={row.checking} aria-label={t('agentList.stepAria', { step: t('agentList.step.check'), label: row.label })} onClick={() => void onCheck?.(row.id).catch(() => undefined)}>
                {row.checking ? t('agentPage.checking') : t('agentList.step.check')}
              </Btn>
            )}
          </>
        )}
      </div>
      {row.installed && row.state !== 'not_installed' && !account && (
        <p className="ag-card-why" data-testid={`card-why-${row.id}`}>
          {t('agentCard.signOutOwn')}
        </p>
      )}
      {session?.paneId && (
        <CardSignIn
          agentId={row.id}
          label={row.label}
          paneId={session.paneId}
          signIn={signIn}
          check={() => (apis.check ?? signedInNow)(row.id, account?.id)}
          pollMs={apis.pollMs}
          onSignedIn={() => {
            requestUsageRefresh();
            onChanged(true);
          }}
          onClose={() => setSession(null)}
        />
      )}
      {message && <Note role={message.error ? 'alert' : 'status'}>{message.text}</Note>}
    </section>
  );
}
