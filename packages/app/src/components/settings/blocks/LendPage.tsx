// Settings > Lend: profiles (who may borrow what, and for how long) and the active lends.
// Lend through my PC: the sign-in stays on this PC. A profile uses a lend sign-in (signed in once in a pane) or a pasted
// API key. The main sign-in is shown but turned off. There is no file to hand over in this mode (no .pm parts).
import { useEffect, useState } from 'react';
import { tauriAccountsApi, type Account, type AccountsApi } from '../../../lib/accounts';
import {
  agentLabel,
  capFor,
  comingSoonAgents,
  comingSoonText,
  DEFAULT_SECS,
  durationProblem,
  durationWords,
  endedWords,
  errText,
  grantLine,
  borrowedBillingNote,
  isActiveIn,
  isActiveOut,
  lendApi,
  limitsText,
  offerable,
  problemText,
  signInProblem,
  supportTag,
  usageText,
  type LendApi,
  type LendProfile,
} from '../../../lib/lend';
import { teamApi, type MemberView, type TeamApi } from '../../../lib/team';
import { DurationField } from '../../lend/Duration';
import { useLend } from '../../lend/useLend';
import { LendWarning } from '../../lend/OwnRiskBox';
import { TestLink } from '../../lend/TestLink';
import '../../../styles/lend.css';

export const MAIN_SIGN_IN_HINT = 'Coming later';
export const ADD_SIGN_IN = 'Add a lend sign-in';
export const PASTE_KEY = 'Paste an API key';

const blank = (): LendProfile => ({
  id: '',
  name: '',
  agent_ids: [],
  account: { kind: 'account', id: '' },
  who: 'my_pcs',
  member_ids: [],
  default_secs: DEFAULT_SECS,
  max_secs: 24 * 3600,
  approval: 'each',
  sign_out_on_end: true,
  keep_awake: true,
  max_requests: null,
  max_tokens: null,
});

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
  const lend = useLend(api);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [members, setMembers] = useState<MemberView[]>([]);
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
      .then((v) => alive && setMembers(v.members.filter((m) => !m.me)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [accountsApi, team]);

  if (!lend.enabled || !lend.state) return null;
  return (
    <section className="lend-page" aria-label="Lend">
      <Profiles api={api} accountsApi={accountsApi} lend={lend} accounts={accounts} members={members} onSaved={onSaved} onAccounts={loadAccounts} />
      <ActiveLends api={api} lend={lend} />
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
  onSaved,
  onAccounts,
}: {
  api: LendApi;
  accountsApi: AccountsApi;
  lend: Lend;
  accounts: Account[];
  members: MemberView[];
  onSaved?: () => void;
  onAccounts: () => void;
}) {
  const state = lend.state!;
  const [editing, setEditing] = useState<LendProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remove = async (p: LendProfile) => {
    setError(null);
    try {
      await api.profileDelete(p.id);
      lend.refresh();
      onSaved?.();
    } catch (err) {
      setError(errText(err));
    }
  };
  return (
    <section className="lend-block" aria-label="Lend profiles">
      <h3>Lend profiles</h3>
      <p className="lend-muted">A profile says who may ask, for which agents, and for how long. Nothing is lent until you say yes or a profile says it may.</p>
      {state.profiles.length === 0 && !editing && <p className="lend-muted">No profiles yet.</p>}
      <ul className="lend-list">
        {state.profiles.map((p) => (
          <li key={p.id}>
            <div className="lend-who">
              <span>{p.name}</span>
              <small>
                {p.agent_ids.map((a) => agentLabel(state, a)).join(', ') || 'No agents'} · {p.who === 'my_pcs' ? 'My PCs' : 'Teammates'} · up to {durationWords(p.max_secs)} ·{' '}
                {p.approval === 'each' ? 'asks first' : 'no questions'}
                {limitsText(p) ? ` · ${limitsText(p)}` : ''}
              </small>
            </div>
            <button type="button" className="lend-btn is-small" onClick={() => setEditing(p)}>
              Edit
            </button>
            <button type="button" className="lend-btn is-small is-plain" aria-label={`Delete ${p.name}`} onClick={() => void remove(p)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p className="lend-error" role="alert">
          {error}
        </p>
      )}
      {editing ? (
        <ProfileEditor
          key={editing.id || 'new'}
          initial={editing}
          api={api}
          accountsApi={accountsApi}
          lend={lend}
          accounts={accounts}
          members={members}
          onAccounts={onAccounts}
          onDone={() => {
            setEditing(null);
            onSaved?.();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <div>
          <button type="button" className="lend-btn" onClick={() => setEditing(blank())}>
            New profile
          </button>
        </div>
      )}
    </section>
  );
}

function ProfileEditor({
  initial,
  api,
  accountsApi,
  lend,
  accounts,
  members,
  onAccounts,
  onDone,
  onCancel,
}: {
  initial: LendProfile;
  api: LendApi;
  accountsApi: AccountsApi;
  lend: Lend;
  accounts: Account[];
  members: MemberView[];
  onAccounts: () => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const state = lend.state!;
  const [p, setP] = useState<LendProfile>(initial);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The sign-in: a lend sign-in signed into once, or a pasted API key. The main sign-in is off for now.
  const [wanted, setHow] = useState<'signin' | 'key'>(initial.has_key ? 'key' : 'signin');
  const [key, setKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [added, setAdded] = useState<Account | null>(null);
  const [adding, setAdding] = useState(false);
  const [signInNote, setSignInNote] = useState<string | null>(null);
  const forOther = p.who === 'teammates';
  const set = (patch: Partial<LendProfile>) => setP((cur) => ({ ...cur, ...patch }));
  const agents = offerable(state.drivers);
  // A sign-in is only offered when every picked agent has one that can be lent; otherwise the key is the way (and why not is said).
  const noSignIn = signInProblem(state.drivers, p.agent_ids);
  const how = noSignIn ? 'key' : wanted;
  const soon = comingSoonAgents(state.drivers);
  const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const firstAgent = p.agent_ids[0] ?? '';
  const known = added && !accounts.some((a) => a.id === added.id) ? [...accounts, added] : accounts;
  const mine = known.filter((a) => p.agent_ids.length === 0 || p.agent_ids.includes(a.agent_id));
  const accountId = p.account.kind === 'account' ? p.account.id : '';
  const haveKey = how === 'key' && ((initial.has_key && !removeKey) || key.trim() !== '');

  const problems: string[] = [];
  if (!p.name.trim()) problems.push('Give it a name.');
  if (p.agent_ids.length === 0) problems.push('Pick at least one agent.');
  if (how === 'signin' && !accountId) problems.push('Add a lend sign-in, or paste an API key.');
  if (how === 'key' && !haveKey) problems.push('Paste an API key.');
  const dur = durationProblem(p.default_secs, forOther) ?? durationProblem(p.max_secs, forOther);
  if (dur) problems.push(dur);
  else if (p.default_secs > p.max_secs) problems.push('The default is longer than the most.');
  if (forOther && !understood) problems.push('Tick "I understand" first.');

  const addSignIn = async () => {
    if (!firstAgent) return;
    setAdding(true);
    setError(null);
    try {
      const made = await api.accountAdd(firstAgent, `Lend ${agentLabel(state, firstAgent)}`);
      setAdded(made);
      set({ account: { kind: 'account', id: made.id } });
      setSignInNote(`Added "${made.label}". Sign in to it once in a pane, then save the profile.`);
      onAccounts();
    } catch (err) {
      setError(errText(err));
    } finally {
      setAdding(false);
    }
  };

  const openToSignIn = async () => {
    const target = known.find((a) => a.id === accountId);
    if (!target) return;
    setError(null);
    try {
      await accountsApi.openLoginPane(target.agent_id, target.id);
    } catch (err) {
      setError(errText(err));
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // A pasted key needs no sign-in; the engine uses the key first, so "main" is only a placeholder there.
      const account = how === 'key' ? ({ kind: 'main' } as const) : p.account;
      const saved = await api.profileSave({
        ...p,
        account,
        name: p.name.trim(),
        member_ids: forOther ? p.member_ids : [],
        max_requests: p.max_requests || null,
        max_tokens: p.max_tokens || null,
        has_key: undefined,
      });
      // The profile exists now: a retry after a failed key save must not make a second one.
      setP((cur) => ({ ...cur, id: saved.id }));
      if (how === 'key' && key.trim()) await api.keySet(saved.id, key.trim());
      else if ((how === 'signin' && initial.has_key) || removeKey) await api.keySet(saved.id, '');
      setKey('');
      lend.refresh();
      onDone();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };

  const numberField = (label: string, value: number | null | undefined, onChange: (n: number | null) => void) => (
    <label className="lend-field">
      <span>{label}</span>
      <input
        type="number"
        min={1}
        aria-label={label}
        className="lend-num"
        style={{ width: 140 }}
        value={value ?? ''}
        placeholder="No limit"
        onChange={(e) => {
          const n = Number.parseInt(e.target.value, 10);
          onChange(Number.isFinite(n) && n > 0 ? n : null);
        }}
      />
    </label>
  );

  return (
    <div className="lend-editor" role="group" aria-label={initial.id ? 'Edit profile' : 'New profile'}>
      <label className="lend-field">
        <span>Name</span>
        <input type="text" aria-label="Name" value={p.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <fieldset className="lend-checks">
        <legend className="lend-legend">Agents</legend>
        {agents.map((d) => (
          <label key={d.agent_id}>
            <input type="checkbox" checked={p.agent_ids.includes(d.agent_id)} onChange={() => set({ agent_ids: toggle(p.agent_ids, d.agent_id) })} />
            <span>{d.label}</span>
            <span className="lend-tag">{supportTag(d.support)}</span>
            {d.account_note && <span className="lend-muted">{d.account_note}</span>}
          </label>
        ))}
        {soon.map((c) => (
          <label key={c.agent_id} aria-disabled="true">
            <input type="checkbox" checked={false} disabled readOnly />
            <span className="lend-muted">{comingSoonText(c.label)}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="lend-checks" aria-label="Sign-in">
        <legend className="lend-legend">Sign-in</legend>
        <label className="lend-radio" aria-disabled={noSignIn ? 'true' : undefined}>
          <input type="radio" name="lend-how" checked={how === 'signin'} disabled={!!noSignIn} onChange={() => setHow('signin')} />
          <span className={noSignIn ? 'lend-muted' : undefined}>A lend sign-in</span>
        </label>
        {noSignIn && (
          <p className="lend-note" role="status" data-testid="lend-signin-not-yet">
            {noSignIn}
          </p>
        )}
        <label className="lend-radio">
          <input type="radio" name="lend-how" checked={how === 'key'} onChange={() => setHow('key')} />
          <span>{PASTE_KEY}</span>
        </label>
        <label className="lend-radio" aria-disabled="true">
          <input type="radio" name="lend-how" disabled checked={false} readOnly />
          <span className="lend-muted">Main sign-in · {MAIN_SIGN_IN_HINT}</span>
        </label>
        {how === 'signin' && (
          <>
            {mine.length > 0 && (
              <label className="lend-field">
                <span>Lend sign-in</span>
                <select aria-label="Lend sign-in" value={accountId} onChange={(e) => set({ account: { kind: 'account', id: e.target.value } })}>
                  <option value="" disabled>
                    Pick a sign-in
                  </option>
                  {mine.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label} · {agentLabel(state, a.agent_id)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="lend-row">
              <button type="button" className="lend-btn" disabled={!firstAgent || adding} onClick={() => void addSignIn()}>
                {ADD_SIGN_IN}
              </button>
              {accountId && (
                <button type="button" className="lend-btn is-plain" onClick={() => void openToSignIn()}>
                  Open it to sign in
                </button>
              )}
            </div>
            {!firstAgent && <span className="lend-muted">Pick an agent first.</span>}
            {signInNote && (
              <p className="lend-note" role="status">
                {signInNote}
              </p>
            )}
          </>
        )}
        {how === 'key' && (
          <div className="lend-field">
            <label className="lend-field">
              <span>{PASTE_KEY}</span>
              <input
                type="password"
                aria-label="API key"
                autoComplete="off"
                value={key}
                placeholder={initial.has_key && !removeKey ? 'A key is saved. Paste a new one to replace it.' : 'Paste the key here'}
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            <span className="lend-muted">It is kept in this PC&apos;s credential store and is never shown again.</span>
            {initial.has_key && (
              <label className="lend-radio">
                <input type="checkbox" checked={removeKey} onChange={(e) => setRemoveKey(e.target.checked)} />
                <span>Remove the saved key</span>
              </label>
            )}
          </div>
        )}
      </fieldset>
      <fieldset className="lend-checks">
        <legend className="lend-legend">Who can ask</legend>
        <label className="lend-radio">
          <input type="radio" name="lend-who" checked={p.who === 'my_pcs'} onChange={() => set({ who: 'my_pcs' })} />
          <span>My PCs</span>
        </label>
        <label className="lend-radio">
          <input type="radio" name="lend-who" checked={p.who === 'teammates'} onChange={() => set({ who: 'teammates' })} />
          <span>Teammates</span>
        </label>
      </fieldset>
      {forOther && (
        <>
          {members.length > 0 && (
            <fieldset className="lend-checks">
              <legend className="lend-legend">Which teammates (none ticked: anyone on the team)</legend>
              {members.map((m) => (
                <label key={m.id}>
                  <input type="checkbox" checked={p.member_ids.includes(m.id)} onChange={() => set({ member_ids: toggle(p.member_ids, m.id) })} />
                  <span>{m.name}</span>
                </label>
              ))}
            </fieldset>
          )}
          <LendWarning agent={p.agent_ids.length === 1 ? agentLabel(state, p.agent_ids[0]) : 'agent'} checked={understood} onChange={setUnderstood} />
        </>
      )}
      <DurationField secs={p.default_secs} onChange={(s) => set({ default_secs: s })} forOther={forOther} label="How long (default)" />
      <DurationField secs={p.max_secs} onChange={(s) => set({ max_secs: s })} forOther={forOther} label={`The most (up to ${durationWords(capFor(forOther))})`} />
      {numberField('Most requests (optional)', p.max_requests, (n) => set({ max_requests: n }))}
      {numberField('Most tokens (optional)', p.max_tokens, (n) => set({ max_tokens: n }))}
      <label className="lend-radio">
        <input type="checkbox" checked={p.approval === 'each'} onChange={(e) => set({ approval: e.target.checked ? 'each' : 'none' })} />
        <span>Ask me before each request</span>
      </label>
      <label className="lend-radio">
        <input type="checkbox" checked={p.sign_out_on_end} onChange={(e) => set({ sign_out_on_end: e.target.checked })} />
        <span>Sign out when it ends</span>
      </label>
      <label className="lend-radio">
        <input type="checkbox" checked={p.keep_awake} onChange={(e) => set({ keep_awake: e.target.checked })} />
        <span>Keep this PC awake while lending</span>
      </label>
      {problems.length > 0 && <p className="lend-muted">{problems[0]}</p>}
      {error && (
        <p className="lend-error" role="alert">
          {error}
        </p>
      )}
      <div className="lend-actions">
        <button type="button" className="lend-btn is-plain" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="lend-btn is-primary" disabled={busy || problems.length > 0} onClick={() => void save()}>
          Save profile
        </button>
      </div>
    </div>
  );
}

// ---------- active lends ----------

function ActiveLends({ api, lend }: { api: LendApi; lend: Lend }) {
  const state = lend.state!;
  const [error, setError] = useState<string | null>(null);
  const live = state.grants.filter((g) => isActiveOut(g, lend.now) || isActiveIn(g, lend.now));
  const ended = state.grants.filter((g) => g.state === 'ended').slice(-3);
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
    <section className="lend-block" aria-label="Active lends">
      <h3>Active lends</h3>
      {live.length === 0 && <p className="lend-muted">Nothing is lent or borrowed right now.</p>}
      {state.keeping_awake && <p className="lend-muted">This PC stays awake while you lend.</p>}
      <ul className="lend-list">
        {live.map((g) => (
          <li key={g.id}>
            <div className="lend-who">
              <span>{grantLine(g, agentLabel(state, g.agent_id), lend.now)}</span>
              {g.peer_device_name && <small>{g.peer_device_name}</small>}
              {usageText(g) && <small className="lend-usage">Used so far: {usageText(g)}</small>}
              {g.direction === 'in' && <small className="lend-note">{borrowedBillingNote(g.peer_name)}</small>}
              {problemText(g) && (
                <small className="lend-problem" role="status">
                  {problemText(g)}
                </small>
              )}
            </div>
            <TestLink grantId={g.id} api={api} />
            <button type="button" className="lend-btn is-small" onClick={() => void act(g.id, g.direction === 'out')}>
              {g.direction === 'out' ? 'Revoke' : 'Give back'}
            </button>
          </li>
        ))}
        {ended.map((g) => (
          <li key={g.id}>
            <div className="lend-who">
              <span className="lend-muted">
                {g.direction === 'out' ? 'Lent' : 'Borrowed'} {agentLabel(state, g.agent_id)} · {g.peer_name}
              </span>
              <small>{endedWords(g)}</small>
            </div>
          </li>
        ))}
      </ul>
      {error && (
        <p className="lend-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
