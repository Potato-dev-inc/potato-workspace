// Example Share-an-agent data for the harness and the tests (dev only), and a fake of the `lend_*` commands.
// The fake keeps its own small state, so Lend, Say no, Revoke and Give back really change what the screens show.
import type { UnlistenFn } from '@tauri-apps/api/event';
import { PANE_CLAUDE } from './fixtures';
import type { Account, BorrowedSignIn } from '../lib/accounts';
import type { Grant, LendApi, LendDriver, LendProfile, LendRequest, LendState } from '../lib/lend';

const now = Date.now();
const MIN = 60_000;

/** What the real backend lists: Claude (key or sign-in), Codex and Gemini (API key only; the other sign-in says why not). */
export const LEND_DRIVERS: LendDriver[] = [
  { agent_id: 'claude', label: 'Claude', support: 'lab', api_key: true, account: true, chat: true, account_note: null },
  { agent_id: 'codex', label: 'Codex', support: 'lab', api_key: true, account: false, chat: true, account_note: 'Codex signed in with ChatGPT is not supported yet. Only an OpenAI API key can be lent.' },
  { agent_id: 'gemini', label: 'Gemini CLI', support: 'lab', api_key: true, account: false, chat: false, account_note: 'Gemini signed in with Google is not supported yet. Only a Gemini API key can be lent.' },
];

export const MY_PROFILE: LendProfile = {
  id: 'prof-mine',
  name: 'My other PCs',
  agent_ids: ['claude'],
  account: { kind: 'account', id: 'acct-lend' },
  who: 'my_pcs',
  member_ids: [],
  default_secs: 8 * 3600,
  max_secs: 24 * 3600,
  approval: 'none',
  sign_out_on_end: true,
  keep_awake: true,
  max_requests: null,
  max_tokens: null,
  has_key: false,
};

/** A profile that lends through a pasted API key (the main sign-in value is only a placeholder). */
export const KEY_PROFILE: LendProfile = {
  ...MY_PROFILE,
  id: 'prof-key',
  name: 'Work key',
  account: { kind: 'main' },
  has_key: true,
  max_requests: 200,
  max_tokens: 500_000,
};

export const TEAM_PROFILE: LendProfile = {
  id: 'prof-team',
  name: 'Teammates, ask first',
  agent_ids: ['claude'],
  account: { kind: 'account', id: 'acct-lend' },
  who: 'teammates',
  member_ids: ['m-maya', 'm-sam'],
  default_secs: 2 * 3600,
  max_secs: 8 * 3600,
  approval: 'each',
  sign_out_on_end: true,
  keep_awake: true,
  max_requests: null,
  max_tokens: null,
  has_key: false,
};

/** Maya borrows my Claude (I lend). */
export const GRANT_OUT: Grant = {
  id: 'grant-out-1',
  direction: 'out',
  agent_id: 'claude',
  peer_member_id: 'm-maya',
  peer_name: 'Maya',
  peer_device_name: "Maya's laptop",
  started_ms: now - 5 * MIN,
  ends_ms: now + 2 * 3600_000 + 14 * MIN,
  state: 'active',
  end_reason: null,
  for_other_person: true,
  pane_ids: [],
  requests: 14,
  input_tokens: 52_300,
  output_tokens: 9_800,
  problem: null,
};

/** I borrow Claude from Sam. */
export const GRANT_IN: Grant = {
  id: 'grant-in-1',
  direction: 'in',
  agent_id: 'claude',
  peer_member_id: 'm-sam',
  peer_name: 'Sam',
  peer_device_name: "Sam's desktop",
  started_ms: now - 20 * MIN,
  ends_ms: now + 40 * MIN,
  state: 'active',
  end_reason: null,
  for_other_person: true,
  pane_ids: [],
  requests: 0,
  input_tokens: 0,
  output_tokens: 0,
  problem: null,
};

/** I borrow Claude from my other PC; a pane of it is open (the pane chip). */
export const GRANT_IN_PANE: Grant = {
  id: 'grant-in-2',
  direction: 'in',
  agent_id: 'claude',
  peer_member_id: 'm-leo',
  peer_name: 'Leo',
  peer_device_name: "Leo's PC",
  started_ms: now - 61 * MIN,
  ends_ms: now + 1 * 3600_000 + 59 * MIN,
  state: 'active',
  end_reason: null,
  for_other_person: false,
  pane_ids: [PANE_CLAUDE],
  requests: 3,
  input_tokens: 4_200,
  output_tokens: 1_100,
  problem: null,
};

/** The lender's sign-in expired: both PCs show it on the lend (the screens use their own sentence, not this text). */
export const GRANT_IN_PROBLEM: Grant = { ...GRANT_IN_PANE, id: 'grant-in-3', problem: 'sign-in expired' };

/** A teammate asks for Claude: the "Use at your own risk" box shows. */
export const REQUEST_MAYA: LendRequest = {
  id: 'req-in-maya',
  direction: 'in',
  member_id: 'm-maya',
  member_name: 'Maya',
  device_name: 'laptop',
  agent_id: 'claude',
  secs: 8 * 3600,
  reason: 'Mine hit its limit and I need to finish the invoice export before standup.',
  at_ms: now - 3 * MIN,
  for_other_person: true,
  state: 'open',
};

/** One of my own PCs asks: no warning. */
export const REQUEST_OWN: LendRequest = {
  id: 'req-in-own',
  direction: 'in',
  member_id: 'm-leo',
  member_name: 'Leo',
  device_name: 'laptop',
  agent_id: 'claude',
  secs: 8 * 3600,
  reason: '',
  at_ms: now - 1 * MIN,
  for_other_person: false,
  state: 'open',
};

export const REQUEST_OUT: LendRequest = {
  id: 'req-out-1',
  direction: 'out',
  member_id: 'm-maya',
  member_name: 'Maya',
  device_name: '',
  agent_id: 'claude',
  secs: 3600,
  reason: '',
  at_ms: now - 30_000,
  for_other_person: true,
  state: 'open',
};

export function lendState(partial: Partial<LendState> = {}): LendState {
  return {
    enabled: true,
    profiles: [MY_PROFILE, TEAM_PROFILE],
    grants: [],
    requests_in: [],
    requests_out: [],
    drivers: LEND_DRIVERS,
    ...partial,
  };
}

/** What `accounts_overview.borrowed` lists for the grants lent to this PC. */
export function borrowedOf(grants: readonly Grant[], now = Date.now()): BorrowedSignIn[] {
  return grants
    .filter((g) => g.direction === 'in' && g.state === 'active' && g.ends_ms > now)
    .map((g) => ({ id: `lend:${g.id}`, agent_id: g.agent_id, label: `${g.peer_name}'s PC (lent)`, ends_ms: g.ends_ms, grant_id: g.id }));
}

/** What a harness scenario sets: the state the mocked `lend_*` commands start from. */
export type LendScenario = Partial<LendState>;

type Handler = { handled: boolean; value?: unknown };

/** The logic of the fake, synchronous. Both the promise-based `LendApi` fake and the harness mock use it. */
export class LendBackend {
  state: LendState;
  readonly calls: string[] = [];
  private listeners = new Set<() => void>();
  private ids = 0;
  /** Lend sign-ins added through `accountAdd`. */
  readonly added: Account[] = [];
  /** What every command except `state` throws when set (a failing path). */
  failWith: string | null = null;

  constructor(seed: LendScenario = {}) {
    this.state = lendState(seed);
  }

  private rec(name: string, ...args: unknown[]) {
    this.calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(',')})`);
    if (this.failWith && name !== 'state') throw new Error(this.failWith);
  }

  private changed() {
    for (const l of this.listeners) l();
  }

  on(cb: () => void): UnlistenFn {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  get(): LendState {
    return JSON.parse(JSON.stringify(this.state)) as LendState;
  }

  profileSave(profile: LendProfile): LendProfile {
    this.rec('profileSave', profile);
    const saved = { ...profile, id: profile.id || `prof-${++this.ids}` };
    const has = this.state.profiles.some((p) => p.id === saved.id);
    this.state = { ...this.state, profiles: has ? this.state.profiles.map((p) => (p.id === saved.id ? saved : p)) : [...this.state.profiles, saved] };
    this.changed();
    return saved;
  }

  profileDelete(id: string): void {
    this.rec('profileDelete', id);
    this.state = { ...this.state, profiles: this.state.profiles.filter((p) => p.id !== id) };
    this.changed();
  }

  request(memberId: string, deviceId: string | null, agentId: string, secs: number, reason: string): LendRequest {
    this.rec('request', memberId, deviceId, agentId, secs, reason);
    const r: LendRequest = {
      id: `req-out-${++this.ids}`,
      direction: 'out',
      member_id: memberId,
      member_name: memberId === 'm-leo' ? 'Leo' : memberId.replace(/^m-/, '').replace(/^./, (c) => c.toUpperCase()),
      device_name: deviceId ?? '',
      agent_id: agentId,
      secs,
      reason,
      at_ms: Date.now(),
      for_other_person: memberId !== 'm-leo',
      state: 'open',
    };
    this.state = { ...this.state, requests_out: [...this.state.requests_out, r] };
    this.changed();
    return r;
  }

  /** The other side answers one of my asks (tests and scenarios). */
  settleOut(requestId: string, accepted: boolean): void {
    const r = this.state.requests_out.find((x) => x.id === requestId);
    if (!r) return;
    this.state = { ...this.state, requests_out: this.state.requests_out.map((x) => (x.id === requestId ? { ...x, state: accepted ? 'accepted' : 'declined' } : x)) };
    this.changed();
  }

  answer(requestId: string, accept: boolean, profileId: string | null, secs: number | null): Grant | null {
    this.rec('answer', requestId, accept, profileId, secs);
    const r = this.state.requests_in.find((x) => x.id === requestId);
    if (!r) throw new Error('That request is gone.');
    this.state = { ...this.state, requests_in: this.state.requests_in.filter((x) => x.id !== requestId) };
    let grant: Grant | null = null;
    if (accept) {
      const t = Date.now();
      grant = {
        id: `grant-${++this.ids}`,
        direction: 'out',
        agent_id: r.agent_id,
        peer_member_id: r.member_id,
        peer_name: r.member_name,
        peer_device_name: r.device_name ? `${r.member_name}'s ${r.device_name}` : '',
        started_ms: t,
        ends_ms: t + (secs ?? r.secs) * 1000,
        state: 'active',
        end_reason: null,
        for_other_person: r.for_other_person,
        pane_ids: [],
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        problem: null,
      };
      this.state = { ...this.state, grants: [...this.state.grants, grant] };
    }
    this.changed();
    return grant;
  }

  private end(grantId: string, why: 'revoked' | 'returned') {
    this.state = {
      ...this.state,
      grants: this.state.grants.map((g) => (g.id === grantId ? { ...g, state: 'ended', end_reason: why, pane_ids: [] } : g)),
    };
    this.changed();
  }

  revoke(grantId: string): void {
    this.rec('revoke', grantId);
    this.end(grantId, 'revoked');
  }

  giveBack(grantId: string): void {
    this.rec('giveBack', grantId);
    this.end(grantId, 'returned');
  }

  startAgent(grantId: string, projectPath: string): { pane_id: string } {
    this.rec('startAgent', grantId, projectPath);
    const pane_id = PANE_CLAUDE;
    this.state = { ...this.state, grants: this.state.grants.map((g) => (g.id === grantId ? { ...g, pane_ids: [...g.pane_ids, pane_id] } : g)) };
    this.changed();
    return { pane_id };
  }

  /** `lend_account_add`: a new lend-only account folder. */
  accountAdd(agentId: string, label: string): Account {
    this.rec('accountAdd', agentId, label);
    const account: Account = { id: `acct-${++this.ids}`, agent_id: agentId, label, home: `C:\\lend\\${agentId}`, lend_only: true };
    this.added.push(account);
    return account;
  }

  /** `lend_key_set`: the key is never kept or echoed; the profile only learns that one is there. */
  keySet(profileId: string, key: string): void {
    this.rec('keySet', profileId, key ? '(key)' : '');
    this.state = { ...this.state, profiles: this.state.profiles.map((p) => (p.id === profileId ? { ...p, has_key: key.trim() !== '' } : p)) };
    this.changed();
  }
}

/** The fake `LendApi` the tests and the dev scenarios use. `backend` is open for setup and for checking calls. */
export function createFakeLendApi(seed: LendScenario = {}): LendApi & { backend: LendBackend; calls: string[] } {
  const b = new LendBackend(seed);
  return {
    backend: b,
    calls: b.calls,
    state: async () => b.get(),
    profileSave: async (p) => b.profileSave(p),
    profileDelete: async (id) => b.profileDelete(id),
    request: async (...a) => b.request(...a),
    answer: async (...a) => b.answer(...a),
    revoke: async (id) => b.revoke(id),
    giveBack: async (id) => b.giveBack(id),
    startAgent: async (...a) => b.startAgent(...a),
    accountAdd: async (...a) => b.accountAdd(...a),
    keySet: async (...a) => b.keySet(...a),
    onChanged: async (cb) => b.on(cb),
  };
}

/** One mock per harness page: answers the `lend_*` commands from the scenario. `handled: false` leaves a command alone. */
export function createLendMock(s: LendScenario | undefined): (cmd: string, args: Record<string, unknown>) => Handler {
  const b = new LendBackend(s ?? { enabled: false });
  if (!s) b.state = { ...b.state, enabled: false };
  return (cmd, a) => {
    if (!cmd.startsWith('lend_')) return { handled: false };
    const v = (value: unknown): Handler => ({ handled: true, value });
    switch (cmd) {
      case 'lend_state':
        return v(b.get());
      case 'lend_profile_save':
        return v(b.profileSave(a.profile as LendProfile));
      case 'lend_profile_delete':
        return v(b.profileDelete(String(a.id)));
      case 'lend_request':
        return v(b.request(String(a.member_id), (a.device_id as string | null) ?? null, String(a.agent_id), Number(a.secs), String(a.reason ?? '')));
      case 'lend_answer':
        return v(b.answer(String(a.request_id), a.accept === true, (a.profile_id as string | null) ?? null, (a.secs as number | null) ?? null));
      case 'lend_revoke':
        return v(b.revoke(String(a.grant_id)));
      case 'lend_return':
        return v(b.giveBack(String(a.grant_id)));
      case 'lend_start_agent':
        return v(b.startAgent(String(a.grant_id), String(a.project_path)));
      case 'lend_account_add':
        return v(b.accountAdd(String(a.agent_id), String(a.label)));
      case 'lend_key_set':
        return v(b.keySet(String(a.profile_id), String(a.key ?? '')));
      default:
        return { handled: false };
    }
  };
}

/** The roster for the Request usage sheet: me with a second PC (listed under "My PCs"), Maya and Sam. */
export const LEND_MEMBERS: import('../lib/team').MemberView[] = [
  { id: 'm-leo', name: 'Leo', roles: ['admin', 'approve', 'watch'], admin: true, me: true, github: 'leo-dev', githubConfirmed: true, devices: 2, deviceList: [{ id: 'd-desk', name: 'Leo desktop', current: true }, { id: 'd-lap', name: 'Leo laptop' }] },
  { id: 'm-maya', name: 'Maya', roles: ['approve', 'watch'], admin: false, me: false, github: 'maya-dev', githubConfirmed: true, devices: 2 },
  { id: 'm-sam', name: 'Sam', roles: ['watch'], admin: false, me: false, github: 'samc', githubConfirmed: false, devices: 1 },
];
