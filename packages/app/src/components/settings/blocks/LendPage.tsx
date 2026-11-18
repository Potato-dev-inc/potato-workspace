// Settings > Lend: profiles (who may borrow what, and for how long) and the active lends.
// Lend through my PC: the sign-in stays on this PC. A profile is made in a four-step sheet (name and agent, sign in, who and
// how long, check and save); the sign-in runs inside the sheet, and an unfinished profile is a draft that waits here
// ("Finish setting up ..."). A profile uses a lend sign-in or a pasted API key. There is no file to hand over in this mode.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../../i18n';
import { tauriAccountsApi, type Account, type AccountsApi } from '../../../lib/accounts';
import {
  agentLabel,
  borrowedBillingNote,
  durationWords,
  endedWords,
  pastGrants,
  PAST_SHOWN,
  errText,
  grantLine,
  isActiveIn,
  isActiveOut,
  lendApi,
  limitsText,
  problemText,
  usageText,
  type LendApi,
  type Grant,
  type LendProfile,
} from '../../../lib/lend';
import { blankDraft, clearDraft, draftFor, draftHasWork, getDraft, setDraft, STEPS, useLendDraft } from '../../../lib/lendDraft';
import { teamApi, type MemberView, type TeamApi } from '../../../lib/team';
import { LendProfileSheet } from '../../lend/LendProfileSheet';
import { TakeBack } from '../../lend/TakeBack';
import { TestLink } from '../../lend/TestLink';
import { useLend } from '../../lend/useLend';
import { Switch } from '../controls';
import { EmptyState } from '../../common/EmptyState';
import '../../../styles/lend.css';

export const PASTE_KEY = 'Paste an API key';

export function LendPage({
  api = lendApi,
  team = teamApi,
  accountsApi = tauriAccountsApi,
  onSaved,
}: {
  api?: LendApi;
  team?: TeamApi;
  accountsApi?: AccountsApi;
  onSaved?: () => void;
}) {
  const t = useT();
  const lend = useLend(api);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [members, setMembers] = useState<MemberView[]>([]);
  const [me, setMe] = useState('');
  const loadAccounts = () =>
    accountsApi
      .list()
      .then((o) => setAccounts(o.accounts.filter((a) => a.lend_only)))
      .catch(() => undefined);
  useEffect(() => {
    let alive = true;
    accountsApi
      .list()
      .then((o) => alive && setAccounts(o.accounts.filter((a) => a.lend_only)))
      .catch(() => undefined);
    team
      .configGet()
      .then((v) => {
        if (!alive) return;
        setMembers(v.members.filter((m) => !m.me));
        setMe(v.members.find((m) => m.me)?.name ?? '');
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [accountsApi, team]);

  if (!lend.known) return null;
  return (
    <section className="lend-page" aria-label={t('lend.page.aria')}>
      {lend.enabled && lend.state ? (
        <>
          <Profiles api={api} accountsApi={accountsApi} lend={lend} accounts={accounts} members={members} me={me} onSaved={onSaved} onAccounts={loadAccounts} />
          <ActiveLends api={api} lend={lend} />
        </>
      ) : (
        <p className="lend-note">{t('lend.status.offHelp')}</p>
      )}
    </section>
  );
}

type Lend = ReturnType<typeof useLend>;

// ---------- profiles ----------

function Profiles({
  api,
  accountsApi,
  lend,
  accounts,
  members,
  me,
  onSaved,
  onAccounts,
}: {
  api: LendApi;
  accountsApi: AccountsApi;
  lend: Lend;
  accounts: Account[];
  members: MemberView[];
  me: string;
  onSaved?: () => void;
  onAccounts: () => void;
}) {
  const t = useT();
  const state = lend.state!;
  const draft = useLendDraft();
  // The sheet is open for a draft that was started in this window; a draft left from before (a reload) waits as a row.
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ name: string } | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const lentNow = (p: LendProfile) => state.grants.filter((g) => isActiveOut(g, lend.now) && (g.profile_id ? g.profile_id === p.id : g.profile_name === p.name));

  const remove = async (p: LendProfile) => {
    setError(null);
    setAsking(null);
    try {
      await api.profileDelete(p.id);
      lend.refresh();
      onSaved?.();
    } catch (err) {
      setError(errText(err));
    }
  };

  const saveShowUsage = async (p: LendProfile, on: boolean) => {
    setError(null);
    try {
      await api.profileSave({ ...p, show_usage: on });
      lend.refresh();
      onSaved?.();
    } catch (err) {
      setError(errText(err));
    }
  };

  const closeSheet = () => {
    const d = getDraft();
    // Changing a saved profile leaves nothing behind; a new one with nothing in it neither. Otherwise it waits as a draft.
    if (d && (d.editing || !draftHasWork(d))) clearDraft();
    setOpen(false);
  };

  const start = () => {
    if (!getDraft()) setDraft(blankDraft());
    setOpen(true);
  };

  const discard = async (removeSignIn: boolean) => {
    const d = getDraft();
    setDiscarding(false);
    clearDraft();
    setOpen(false);
    if (removeSignIn && d?.createdId) {
      try {
        await accountsApi.remove(d.createdId, true);
        onAccounts();
      } catch (err) {
        setError(errText(err));
      }
    }
  };

  const showDraft = !!draft && !draft.editing && !open;
  return (
    <section className="lend-block" aria-label={t('lend.profiles')}>
      <h3>{t('lend.profiles')}</h3>
      <p className="lend-muted">{t('lend.profilesHelp')}</p>
      {state.profiles.length === 0 && !draft && (
        <EmptyState
          testId="lend-empty"
          title={t('lend.emptyTitle')}
          line={t('lend.emptyLine')}
          action={{ label: t('lend.newLendProfile'), onClick: start }}
        />
      )}
      <ul className="lend-list">
        {showDraft && (
          <li className="lend-draft" data-testid="lend-draft-row">
            <div className="lend-who">
              <span>
                {draft.profile.name.trim()
                  ? t('lend.draft.row', { name: draft.profile.name.trim(), n: draft.step, total: STEPS })
                  : `${t('lend.draft.unnamed')} · ${t('lend.step', { n: draft.step, total: STEPS })}`}
              </span>
              {discarding && <small>{t('lend.draft.removeSignIn')}</small>}
            </div>
            {discarding ? (
              <>
                <button type="button" className="lend-btn is-small" onClick={() => void discard(true)}>
                  {t('lend.draft.remove')}
                </button>
                <button type="button" className="lend-btn is-small is-plain" onClick={() => void discard(false)}>
                  {t('lend.draft.keep')}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="lend-btn is-small is-primary" onClick={() => setOpen(true)}>
                  {t('lend.draft.continue')}
                </button>
                <button
                  type="button"
                  className="lend-btn is-small is-plain"
                  onClick={() => (draft.createdId ? setDiscarding(true) : void discard(false))}
                >
                  {t('lend.draft.discard')}
                </button>
              </>
            )}
          </li>
        )}
        {state.profiles.map((p) => (
          <li key={p.id} data-flash={saved?.name === p.name ? 'true' : undefined}>
            <div className="lend-who">
              <span>{p.name}</span>
              <small>
                {p.agent_ids.map((a) => agentLabel(state, a)).join(', ') || t('lend.noAgents')} · {p.who === 'my_pcs' ? t('lend.who.myPcs') : t('lend.who.teammates')} · {t('lend.upTo', { time: durationWords(p.max_secs) })} ·{' '}
                {p.approval === 'each' ? t('lend.asksFirst') : t('lend.noQuestions')}
                {limitsText(p) ? ` · ${limitsText(p)}` : ''}
              </small>
              {p.account.kind === 'account' && (
                <div className="lend-showusage">
                  <span className="lend-showusage-line">
                    <Switch checked={p.show_usage === true} onChange={(on) => void saveShowUsage(p, on)} label={`${p.name}: ${t('lend.showUsage')}`} />
                    {t('lend.showUsage')}
                  </span>
                  <small className="lend-muted">{t('lend.showUsageHint')}</small>
                </div>
              )}
              {asking === p.id && (
                <small className="lend-problem" role="alert">
                  {t('lend.delete.lent', { name: p.name, peer: lentNow(p)[0]?.peer_name ?? '' })}
                </small>
              )}
            </div>
            {asking === p.id ? (
              <>
                <button type="button" className="lend-btn is-small is-primary" onClick={() => void remove(p)}>
                  {t('lend.delete.sure')}
                </button>
                <button type="button" className="lend-btn is-small is-plain" onClick={() => setAsking(null)}>
                  {t('lend.cancel')}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="lend-btn is-small"
                  disabled={showDraft}
                  onClick={() => {
                    setDraft(draftFor(p));
                    setOpen(true);
                  }}
                >
                  {t('lend.edit')}
                </button>
                <button
                  type="button"
                  className="lend-btn is-small is-plain"
                  aria-label={t('lend.deleteName', { name: p.name })}
                  onClick={() => (lentNow(p).length > 0 ? setAsking(p.id) : void remove(p))}
                >
                  {t('lend.delete')}
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {saved && (
        <p className="lend-note" role="status" data-testid="lend-saved">
          {t('lend.saved', { name: saved.name })}
        </p>
      )}
      {error && (
        <p className="lend-error" role="alert">
          {error}
        </p>
      )}
      {!open && !showDraft && state.profiles.length > 0 && (
        <div>
          <button type="button" className="lend-btn" onClick={start}>
            {t('lend.newLendProfile')}
          </button>
        </div>
      )}
      {open && draft && (
        <LendProfileSheet
          api={api}
          lend={lend}
          accounts={accounts}
          members={members}
          me={me}
          onClose={closeSheet}
          onAccounts={onAccounts}
          onSaved={(name) => {
            clearDraft();
            setOpen(false);
            setSaved({ name });
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setSaved(null), 6000);
            onSaved?.();
          }}
        />
      )}
    </section>
  );
}

// ---------- active lends ----------

function ActiveLends({ api, lend }: { api: LendApi; lend: Lend }) {
  const t = useT();
  const state = lend.state!;
  const [error, setError] = useState<string | null>(null);
  const live = state.grants.filter((g) => isActiveOut(g, lend.now) || isActiveIn(g, lend.now));
  const pastOut = pastGrants(state.grants, 'out', lend.now);
  const pastIn = pastGrants(state.grants, 'in', lend.now);
  const act = async (id: string, out: boolean) => {
    setError(null);
    try {
      await (out ? api.revoke(id) : api.giveBack(id));
      lend.refresh();
    } catch (err) {
      setError(errText(err));
    }
  };
  return (
    <section className="lend-block" aria-label={t('lend.active')}>
      <h3>{t('lend.active')}</h3>
      {live.length === 0 && <p className="lend-muted">{t('lend.nothing')}</p>}
      {state.keeping_awake && <p className="lend-muted">{t('lend.staysAwake')}</p>}
      <ul className="lend-list">
        {live.map((g) => (
          <li key={g.id}>
            <div className="lend-who">
              <span>{grantLine(g, agentLabel(state, g.agent_id), lend.now)}</span>
              {g.peer_device_name && <small>{g.peer_device_name}</small>}
              {usageText(g) && <small className="lend-usage">{t('lend.usedSoFar', { used: usageText(g) ?? '' })}</small>}
              {g.direction === 'in' && <small className="lend-note">{borrowedBillingNote(g.peer_name)}</small>}
              {problemText(g) && (
                <small className="lend-problem" role="status">
                  {problemText(g)}
                </small>
              )}
            </div>
            <TestLink grantId={g.id} api={api} />
            {g.direction === 'out' ? (
              <TakeBack profile={g.profile_name || agentLabel(state, g.agent_id)} peer={g.peer_name} onConfirm={() => void act(g.id, true)} />
            ) : (
              <button type="button" className="lend-btn is-small" onClick={() => void act(g.id, false)}>
                {t('lend.giveBack')}
              </button>
            )}
          </li>
        ))}
      </ul>
      <PastList direction="in" rows={pastIn} api={api} lend={lend} onError={setError} />
      <PastList direction="out" rows={pastOut} api={api} lend={lend} onError={setError} />
      {error && (
        <p className="lend-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Past lends or past borrows: collapsed, the last five (newest first), an X on each row and "Clear". */
function PastList({
  direction,
  rows,
  api,
  lend,
  onError,
}: {
  direction: 'out' | 'in';
  rows: Grant[];
  api: LendApi;
  lend: Lend;
  onError: (message: string | null) => void;
}) {
  const t = useT();
  const state = lend.state!;
  const [all, setAll] = useState(false);
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, PAST_SHOWN);
  const run = async (work: () => Promise<unknown>) => {
    onError(null);
    try {
      await work();
      lend.refresh();
    } catch (err) {
      onError(errText(err));
    }
  };
  return (
    <details className="lend-past" data-testid={`lend-past-${direction}`}>
      <summary>
        {direction === 'out' ? t('lend.past.lends', { n: rows.length }) : t('lend.past.borrows', { n: rows.length })}
      </summary>
      <ul className="lend-list">
        {shown.map((g) => (
          <li key={g.id}>
            <div className="lend-who">
              <span className="lend-muted">
                {agentLabel(state, g.agent_id)} · {g.profile_name || g.peer_name}
                {g.profile_name && g.peer_name ? ` · ${g.peer_name}` : ''}
              </span>
              <small>{endedWords(g)}</small>
            </div>
            {api.dismissGrant && (
              <button
                type="button"
                className="lend-btn is-small is-plain"
                aria-label={t('lend.past.dismiss')}
                title={t('lend.past.dismiss')}
                onClick={() => void run(() => api.dismissGrant!(g.id))}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="lend-past-foot">
        {rows.length > PAST_SHOWN && !all && (
          <button type="button" className="lend-btn is-small is-plain" onClick={() => setAll(true)}>
            {t('lend.past.showAll', { n: rows.length })}
          </button>
        )}
        {api.clearPast && (
          <button type="button" className="lend-btn is-small is-plain" onClick={() => void run(() => api.clearPast!(direction))}>
            {t('lend.past.clear')}
          </button>
        )}
      </div>
    </details>
  );
}
