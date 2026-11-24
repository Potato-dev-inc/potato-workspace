// Lend through my PC (Labs `lend_enabled`, off by default): lend an agent sign-in to another PC, or borrow one.
//
// The Rust side (src-tauri/src/capacity_proxy) holds everything; this file is the typed command surface and the copy.
// The lender's sign-in never leaves the lender's PC: a grant says who, which agent and until when. A borrowed grant is
// one more sign-in for the borrower (`lend:<grant id>`, see lib/accounts.ts). A request that arrives from a teammate is
// untrusted data (rendered as plain text, the reason always in quotes).
import { errorSentence } from './sayError';
import { t } from '../i18n';
import { lessThan, unit } from './unitWords';
import { invoke } from '@tauri-apps/api/core';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { listen } from './events';
import type { Account } from './accounts';

export type Support = 'verified' | 'lab' | 'no';

export type LendAccount = { kind: 'main' } | { kind: 'account'; id: string };

export type LendWho = 'my_pcs' | 'teammates';

export interface LendProfile {
  /** Empty for a new profile; `lend_profile_save` gives it one. */
  id: string;
  name: string;
  agent_ids: string[];
  account: LendAccount;
  who: LendWho;
  member_ids: string[];
  default_secs: number;
  max_secs: number;
  approval: 'each' | 'none';
  sign_out_on_end: boolean;
  /** Keep this PC awake while a lend from this profile is active. */
  keep_awake: boolean;
  /** Optional caps per lend. Absent or null: no cap. */
  max_requests?: number | null;
  max_tokens?: number | null;
  /** Read only: a pasted API key is kept for this profile. The key itself never comes back. */
  has_key?: boolean;
  /** "Show usage in the usage bar": this profile's sign-in is a row in the bar, and the borrower sees its numbers. Off by default. */
  show_usage?: boolean;
}

export type GrantEnd = 'expired' | 'revoked' | 'returned';

/** Why a grant has a problem, so the words fit: the lender's sign-in, the lender's PC not answering, or a limit. */
export type ProblemKind = 'signin' | 'unreachable' | 'limit';

export interface Grant {
  id: string;
  /** `out`: I lend it. `in`: I borrow it. */
  direction: 'out' | 'in';
  agent_id: string;
  peer_member_id: string;
  peer_name: string;
  peer_device_name: string;
  started_ms: number;
  ends_ms: number;
  state: 'requested' | 'active' | 'ended';
  end_reason: GrantEnd | null;
  for_other_person: boolean;
  pane_ids: string[];
  /** Usage through this lend. Counted on the lender's gate and on the borrower's shim. */
  requests?: number;
  input_tokens?: number;
  output_tokens?: number;
  /** Something is wrong with the lender's sign-in right now (shown on both PCs). Absent or null: all fine. */
  problem?: string | null;
  /** What kind of problem it is. Absent: an older build, which only ever meant the lender's sign-in. */
  problem_kind?: ProblemKind | null;
  /** The lender's name for the profile this lend comes from, as the lender sent it. Absent: an older lender build. */
  profile_name?: string;
  /** When it ended, in epoch milliseconds. Absent while it runs and for a lend saved by an older build (then `ends_ms`). */
  ended_ms?: number | null;
  /** `lender restarted` or `borrower restarted` when a PC of the pair restarting ended it, or `not held` when the borrower no longer had the lend (set by this PC, never text from the other one). */
  end_note?: string | null;
  /** Lender only: which of my profiles this lend comes from (so deleting the profile can say it is lent). */
  profile_id?: string;
  /** The other PC's device-link node when it is one of my own PCs (Use my own agents: Connect names the PC by it). */
  peer_node?: string;
}

/** What a lender offers me (the lender's words and numbers only): one profile of theirs and the agent it lends. */
export interface Offer {
  profile_id: string;
  name: string;
  agent_id: string;
  max_secs: number;
  default_secs: number;
  asks_first: boolean;
  /** Which of their PCs said it (the ask goes to that one). */
  device_id: string;
  device_name: string;
}

/** `answered` false: no PC of theirs answered in time (an older build, asleep or offline). */
export interface OffersResult {
  answered: boolean;
  offers: Offer[];
}

export interface LendRequest {
  id: string;
  direction: 'out' | 'in';
  member_id: string;
  member_name: string;
  device_name: string;
  agent_id: string;
  secs: number;
  reason: string;
  at_ms: number;
  for_other_person: boolean;
  state: 'open' | 'accepted' | 'declined';
  /** The profile of the lender that was asked for (picked from the offers). Absent: the lender chooses. */
  profile_id?: string | null;
  /** Incoming only: that profile's name on this PC. */
  profile_name?: string;
}

export interface LendDriver {
  agent_id: string;
  label: string;
  support: Support;
  /** The lender can paste an API key for this agent. */
  api_key: boolean;
  /** The lender can lend a signed-in account of this agent (a lend sign-in). */
  account: boolean;
  /** A borrowed chat (not only a terminal) works. */
  chat: boolean;
  /** A sign-in of this agent that cannot be lent yet, in plain words. Shown, never offered. */
  account_note?: string | null;
}

export interface LendState {
  enabled: boolean;
  profiles: LendProfile[];
  grants: Grant[];
  requests_in: LendRequest[];
  requests_out: LendRequest[];
  drivers: LendDriver[];
  /** This PC is being held awake right now for an outgoing lend. */
  keeping_awake?: boolean;
}

/** What Test link found. `via`: the PC link ("direct" or "relay") or the team relay ("mailbox"). */
export interface LinkTest {
  ok: boolean;
  ms: number | null;
  via: 'direct' | 'relay' | 'mailbox' | null;
  /** Plain words, ready to show. */
  message: string;
}

/** Where a lend sign-in stands. `expired`: a token is there but its own time has passed. */
export type SignInState = 'signed_in' | 'signed_out' | 'expired';

/** What the sign-in step reads. `identity` (who is signed in) is shown on this PC only and is never sent anywhere. */
export interface SignInStatus {
  state: SignInState;
  identity: string | null;
  /** The hidden sign-in pane still runs. */
  pane_alive: boolean;
}

export interface LendApi {
  state: () => Promise<LendState>;
  profileSave: (profile: LendProfile) => Promise<LendProfile>;
  profileDelete: (id: string) => Promise<void>;
  request: (memberId: string, deviceId: string | null, agentId: string, secs: number, reason: string, profileId?: string | null, profileName?: string | null) => Promise<LendRequest>;
  /** Ask one of my own paired PCs (a device node) to lend an agent, over the device link. No Team needed. */
  requestOwn?: (node: string, agentId: string, secs: number, reason: string) => Promise<LendRequest>;
  /** What can I borrow from this person (or this PC of mine)? Waits a few seconds for the answer. */
  offers: (memberId: string, deviceId: string | null) => Promise<OffersResult>;
  answer: (requestId: string, accept: boolean, profileId: string | null, secs: number | null) => Promise<Grant | null>;
  revoke: (grantId: string) => Promise<void>;
  giveBack: (grantId: string) => Promise<void>;
  /** The X on a past lend or borrow: forgets that ended row. Absent from an older backend. */
  dismissGrant?: (grantId: string) => Promise<boolean>;
  /** "Clear" on past lends (`out`) or past borrows (`in`): forgets every ended row of that side. Absent from an older backend. */
  clearPast?: (direction: 'out' | 'in') => Promise<number>;
  /** Test link: opens the real link handshake to the other PC and reports. Absent from an older backend. */
  testLink?: (grantId: string) => Promise<LinkTest>;
  /** The Lending tab opened: ask each borrower whether it still holds its lend; ones it does not hold end with a note. Absent from an older backend. */
  recheckLent?: () => Promise<number>;
  startAgent: (grantId: string, projectPath: string) => Promise<{ pane_id: string }>;
  /**
   * A new lend sign-in: an app-managed account folder for `agentId`, marked lend-only. `reuse` (the draft's own account)
   * gives that one back while it is still signed out, so a retry never makes a second one.
   */
  accountAdd: (agentId: string, label: string, reuse?: string | null) => Promise<Account>;
  /** Starts the sign-in in a hidden pane that belongs to the sheet (not in the sidebar, never selected). */
  signInStart: (accountId: string) => Promise<{ pane_id: string }>;
  signInStatus: (accountId: string) => Promise<SignInStatus>;
  /** Stops the hidden pane. `removeIfEmpty`: forget the account when it holds no sign-in. True when it was removed. */
  signInStop: (accountId: string, removeIfEmpty: boolean) => Promise<boolean>;
  /** The API key pasted into a profile, into the OS credential store. An empty key removes it. Never returned. */
  keySet: (profileId: string, key: string) => Promise<void>;
  onChanged: (cb: () => void) => Promise<UnlistenFn>;
}

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const noop: UnlistenFn = () => {};

function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error(`Desktop shell required: ${command}`));
  return invoke<T>(command, args);
}

export const lendApi: LendApi = {
  state: () => call('lend_state'),
  profileSave: (profile) => call('lend_profile_save', { profile }),
  profileDelete: (id) => call('lend_profile_delete', { id }),
  request: (memberId, deviceId, agentId, secs, reason, profileId, profileName) =>
    call('lend_request', { member_id: memberId, device_id: deviceId, agent_id: agentId, secs, reason, profile_id: profileId ?? null, profile_name: profileName ?? null }),
  requestOwn: (node, agentId, secs, reason) => call('lend_request_own', { node, agent_id: agentId, secs, reason, profile_id: null, profile_name: null }),
  offers: (memberId, deviceId) => call('lend_offers', { member_id: memberId, device_id: deviceId }),
  answer: (requestId, accept, profileId, secs) => call('lend_answer', { request_id: requestId, accept, profile_id: profileId, secs }),
  revoke: (grantId) => call('lend_revoke', { grant_id: grantId }),
  giveBack: (grantId) => call('lend_return', { grant_id: grantId }),
  dismissGrant: (grantId) => call('lend_grant_dismiss', { grant_id: grantId }),
  clearPast: (direction) => call('lend_past_clear', { direction }),
  testLink: (grantId) => call('lend_test_link', { grant_id: grantId }),
  recheckLent: () => call('lend_recheck_lent'),
  startAgent: (grantId, projectPath) => call('lend_start_agent', { grant_id: grantId, project_path: projectPath }),
  accountAdd: (agentId, label, reuse) => call('lend_account_add', { agent_id: agentId, label, reuse: reuse ?? null }),
  signInStart: (accountId) => call('lend_signin_start', { account_id: accountId }),
  signInStatus: (accountId) => call('lend_signin_status', { account_id: accountId }),
  signInStop: (accountId, removeIfEmpty) => call('lend_signin_stop', { account_id: accountId, remove_if_empty: removeIfEmpty }),
  keySet: (profileId, key) => call('lend_key_set', { profile_id: profileId, key }),
  onChanged: (cb) => (isTauri() ? listen('lend://changed', () => cb()) : Promise.resolve(noop)),
};

// ------------------------------------------------------------------------------------- rules

export const LEND_LABS_KEY = 'lend_enabled' as const;

export function lendEnabled(settings: { lend_enabled?: boolean } | null | undefined): boolean {
  return settings?.lend_enabled === true;
}

export const HOUR = 3600;
/** The presets on every duration field, in seconds. 8 hours is the default. */
export const PRESETS = [
  { secs: 1 * HOUR, label: '1 hour' },
  { secs: 8 * HOUR, label: '8 hours' },
  { secs: 24 * HOUR, label: '24 hours' },
] as const;
export const DEFAULT_SECS = 8 * HOUR;
/** The longest a lend can be: 7 days, or 24 hours when the borrower is another person. */
export const CAP_SECS = 7 * 24 * HOUR;
export const CAP_OTHER_SECS = 24 * HOUR;
/** Longest reason, in characters (the same as a team note). */
export const MAX_REASON = 280;

export const capFor = (forOtherPerson: boolean): number => (forOtherPerson ? CAP_OTHER_SECS : CAP_SECS);

/** "1 hour", "8 hours", "1 h 30 min", "45 min", "2 days". */
export function durationWords(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  if (s % (24 * HOUR) === 0 && s >= 24 * HOUR * 2) return t('lend.dur.days', { n: s / (24 * HOUR) });
  const h = Math.floor(s / HOUR);
  const m = Math.round((s % HOUR) / 60);
  if (h === 0) return t('lend.dur.min', { m });
  if (m === 0) return h === 1 ? t('lend.dur.hour') : t('lend.dur.hours', { h });
  return t('lend.dur.hm', { h, m });
}

/** Hours and minutes typed in the Custom field to seconds. NaN-safe: anything unreadable is 0. */
export function customSecs(hours: string, minutes: string): number {
  const h = Number.parseInt(hours || '0', 10);
  const m = Number.parseInt(minutes || '0', 10);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || m < 0) return 0;
  return h * HOUR + m * 60;
}

/** Why a length cannot be used, in a plain sentence; null when it is fine. */
export function durationProblem(secs: number, forOtherPerson: boolean): string | null {
  if (secs < 60) return t('lend.dur.atLeast');
  const cap = capFor(forOtherPerson);
  if (secs > cap) return forOtherPerson ? t('lend.dur.otherMax') : t('lend.dur.max7');
  return null;
}

/** "2h 14m", "40m", "1m" (the last minute), "3d 2h". The time left on a grant. */
export function leftText(ms: number): string {
  if (ms <= 0) return t('lend.ended');
  const total = Math.ceil(ms / 60_000);
  if (total < 1) return lessThan('m');
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d > 0) return `${unit('d', d)} ${unit('h', h)}`;
  if (h > 0) return `${unit('h', h)} ${unit('m', m)}`;
  return unit('m', m);
}

export type Urgency = 'calm' | 'soon' | 'now';
/** The chip is grey, then orange at 10 minutes, then orange and filled at 1 (red is kept for errors). */
export function urgencyOf(msLeft: number): Urgency {
  if (msLeft <= 60_000) return 'now';
  if (msLeft <= 10 * 60_000) return 'soon';
  return 'calm';
}

export const isActiveIn = (g: Grant, now: number): boolean => g.direction === 'in' && g.state === 'active' && g.ends_ms > now;
export const isActiveOut = (g: Grant, now: number): boolean => g.direction === 'out' && g.state === 'active' && g.ends_ms > now;

/** The active lend of `agentId` that this PC gave to the PC `node` (a far chat there can switch to it), if any. */
export const activeLendTo = (grants: readonly Grant[], now: number, node: string, agentId: string): Grant | undefined =>
  grants.find((g) => isActiveOut(g, now) && g.peer_node === node && g.agent_id.toLowerCase() === agentId.toLowerCase());

/** The agent's name from the driver list, else the id with a capital. */
export function agentLabel(state: Pick<LendState, 'drivers'> | null | undefined, id: string): string {
  const hit = state?.drivers.find((d) => d.agent_id === id)?.label;
  return hit ?? (id ? id[0].toUpperCase() + id.slice(1) : t('lend.agent'));
}

/** Agents a person may ask for or lend: verified, or lab (tagged). `no` is never offered. */
export function offerable(drivers: readonly LendDriver[]): LendDriver[] {
  return drivers.filter((d) => d.support !== 'no');
}

/** Agents shown in the lists as "<Agent>: coming soon" and never offered. None today: Codex and Gemini lend with an API key. */
export const COMING_SOON: readonly { agent_id: string; label: string }[] = [];

export const comingSoonText = (label: string): string => t('lend.comingSoon', { label });

/** The coming-soon agents that have no working driver in this state. */
export function comingSoonAgents(drivers: readonly LendDriver[]): { agent_id: string; label: string }[] {
  return COMING_SOON.filter((c) => !drivers.some((d) => d.agent_id === c.agent_id && d.support !== 'no'));
}

/**
 * Why a lend sign-in cannot be used for these agents, or null when it can. A sign-in is not offered when any picked
 * agent has none that can be lent (the words come from that agent's own lend spec).
 */
export function signInProblem(drivers: readonly LendDriver[], agentIds: readonly string[]): string | null {
  const blocked = drivers.find((d) => agentIds.includes(d.agent_id) && !d.account);
  if (!blocked) return null;
  return blocked.account_note || t('lend.apiKeyOnly', { label: blocked.label });
}

export const supportTag = (s: Support): string => (s === 'verified' ? t('lend.support.works') : s === 'lab' ? t('lend.support.lab') : t('lend.support.no'));

/** "Leo's laptop": a device name that already starts with the owner is kept as it is. */
export function ownerOf(person: string, device: string): string {
  return device.toLowerCase().startsWith(person.toLowerCase()) ? device : t('lend.ownerOf', { person, device });
}

/** "Leo's laptop wants Claude for 8 hours". */
export function requestTitle(r: LendRequest, agent: string): string {
  const who = r.device_name ? ownerOf(r.member_name, r.device_name) : r.member_name;
  const profile = cleanName(r.profile_name);
  if (profile) return t('lend.wantsProfile', { who, profile, agent, time: durationWords(r.secs) });
  return t('lend.wants', { who, agent, time: durationWords(r.secs) });
}

/** The longest profile name that is shown (the other PC's words are cut to this, like the request reason). */
export const MAX_PROFILE_NAME = 60;

/** A name that came from another PC: plain text only, control characters dropped, cut to 60 characters. */
export function cleanName(raw: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  const plain = (raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return [...plain].slice(0, MAX_PROFILE_NAME).join('');
}

type NameParts = Pick<Grant, 'peer_name' | 'peer_device_name' | 'for_other_person' | 'profile_name'>;

/** The one name a PC goes by in lend rows, notices, the Inbox and Connect: its device name, else the account label, else plain words. */
export const displayName = (p: { device?: string | null; label?: string | null }): string => cleanName(p.device) || cleanName(p.label) || t('lend.otherPc');

/** Who the other side is: the person, else the PC (my own other PC has no person), else plain words. */
export const peerLabel = (g: Pick<Grant, 'peer_name' | 'peer_device_name'>): string => cleanName(g.peer_name) || cleanName(g.peer_device_name) || t('lend.otherPc');

/** The name in a row or notice about a lend: my own PC by `displayName` (the same on both PCs), anyone else by `peerLabel`. */
export const rowName = (g: Pick<Grant, 'peer_name' | 'peer_device_name' | 'for_other_person'>): string => (g.for_other_person ? peerLabel(g) : displayName({ device: g.peer_device_name, label: g.peer_name }));

const startsWithOwner = (profile: string, owner: string): boolean => owner !== '' && profile.toLowerCase().startsWith(owner.toLowerCase());

/**
 * The name a borrower sees everywhere: "Claude · Ren's Work account (borrowed)". When the profile name already starts with
 * the owner ("Ren's work account") it is not prefixed again; from my own other PC it is "Claude · Work account on Desk-PC
 * (borrowed)"; from an older lender (no name sent) it is "Claude · Ren's PC (borrowed)".
 */
export function borrowedName(agent: string, g: NameParts): string {
  const profile = cleanName(g.profile_name);
  const owner = peerLabel(g);
  if (!profile) return t('lend.borrowedNamePc', { agent, owner });
  if (!g.for_other_person && g.peer_device_name) return t('lend.borrowedNameMine', { agent, profile, device: g.peer_device_name });
  if (startsWithOwner(profile, owner)) return t('lend.borrowedNameBare', { agent, profile });
  return t('lend.borrowedName', { agent, owner, profile });
}

/** The short form for tight places (the pane chip, the 10-minute toast): "Ren's Work account", or "Leo's Claude" with no name. */
export function borrowedShort(agent: string, g: NameParts): string {
  const profile = cleanName(g.profile_name);
  if (!profile) return t('lend.ownerOf', { person: peerLabel(g), device: agent });
  // My own other PC: the owner is me, so the name alone says it.
  return !g.for_other_person || startsWithOwner(profile, peerLabel(g)) ? profile : t('lend.borrowedShort', { owner: peerLabel(g), profile });
}

/** "Lending Claude to Maya · 2h 14m left" / "Borrowing Codex from Leo · 40m left"; with a profile name it leads with the name. */
export function grantLine(g: Grant, agent: string, now: number): string {
  const time = leftText(g.ends_ms - now);
  const profile = cleanName(g.profile_name);
  if (g.direction === 'out') {
    return profile ? t('lend.lendingNamed', { profile, peer: peerLabel(g), time }) : t('lend.lendingTo', { agent, peer: peerLabel(g), time });
  }
  return profile ? t('lend.borrowingNamed', { name: borrowedName(agent, g), time }) : t('lend.borrowingFrom', { agent, peer: peerLabel(g), time });
}

/** The sentence shown on both PCs when `problem` is set. The Rust side sends its own words; this is the same text. */
export const signinProblemText = (): string => t('lend.signinExpired');

/**
 * What to show for a grant's `problem`, picked by its kind: the lender's sign-in (worded for the lender or the borrower),
 * the lender's PC not answering, or a limit. No kind (an older build) is the old sentence. Null when all is fine.
 */
export function problemText(g: Pick<Grant, 'problem'> & Partial<Pick<Grant, 'problem_kind' | 'direction' | 'peer_name' | 'peer_device_name' | 'profile_name'>>): string | null {
  if (!g.problem) return null;
  const peer = peerLabel({ peer_name: g.peer_name ?? '', peer_device_name: g.peer_device_name ?? '' });
  const profile = cleanName(g.profile_name) || t('lend.thisProfile');
  switch (g.problem_kind) {
    case 'unreachable':
      return t('lend.problem.unreachable', { owner: peer });
    case 'limit':
      return t('lend.limitHit', { owner: peer });
    case 'signin':
      return g.direction === 'out' ? t('lend.problem.signinLender', { profile, peer }) : t('lend.problem.signinBorrower', { owner: peer, profile });
    default:
      return signinProblemText();
  }
}

/** "12 requests · 3.4k tokens", or null while nothing was used (the borrower's PC may not count). */
export function usageText(g: Pick<Grant, 'requests' | 'input_tokens' | 'output_tokens'>): string | null {
  // Requests only: a number of tokens means nothing to most people.
  const requests = g.requests ?? 0;
  if (requests === 0) return null;
  return t('lend.usage', { requests, count: requests });
}

/** The limits of a profile as one line, or null when it has none. */
export function limitsText(p: Pick<LendProfile, 'max_requests' | 'max_tokens'>): string | null {
  const parts: string[] = [];
  if (p.max_requests) parts.push(t('lend.limit.requests', { n: p.max_requests }));
  return parts.length > 0 ? t('lend.limit.upTo', { parts: parts.join(t('lend.and')) }) : null;
}

/** The pane chip: "Ren's Work account · 1h 59m" ("Leo's Claude · 1h 59m" when the lender sent no name). */
export function chipText(g: Grant, agent: string, now: number): string {
  if (g.problem_kind === 'unreachable' && g.problem) return `${borrowedShort(agent, g)} · ${t('lend.chip.notAnswering')}`;
  return `${borrowedShort(agent, g)} · ${leftText(g.ends_ms - now)}`;
}

/** Why a grant ended, in a plain sentence. */
/** Ended rows are kept this long (a week) and then dropped. The desktop drops them from its saved state too. */
export const PAST_KEEP_MS = 7 * 24 * 3600 * 1000;
/** How many past lends or borrows show before "Show all". */
export const PAST_SHOWN = 5;

/** The ended rows of one side, newest first, without anything older than a week. */
export function pastGrants(grants: Grant[], direction: 'out' | 'in', now: number): Grant[] {
  const endedAt = (g: Grant) => g.ended_ms ?? g.ends_ms;
  // A row saved by an older build has no end time; its planned end can be later than a real one, so those go below the dated rows.
  const dated = (g: Grant) => (g.ended_ms ? 1 : 0);
  return grants
    .filter((g) => g.state === 'ended' && g.direction === direction && now - endedAt(g) < PAST_KEEP_MS)
    .sort((a, b) => dated(b) - dated(a) || endedAt(b) - endedAt(a));
}

/** The one line for a lend that ended on its own (the lender's restart, a take-back, time up); null when the person did it or it is not news. */
export function endedNotice(g: Grant): string | null {
  const restarted = g.end_note === 'lender restarted';
  if (g.direction === 'in' && g.end_note === 'borrower restarted') return t('lend.endedNotice', { reason: t('lend.endedWhy.myRestart') });
  if (g.direction === 'out') {
    const why = endNoteWords(g);
    return why ? t('lend.endedNotice', { reason: why }) : null;
  }
  if (g.end_reason === 'returned') return null;
  return t('lend.endedNotice', { reason: t(restarted ? 'lend.endedWhy.theirRestart' : g.end_reason === 'revoked' ? 'lend.endedWhy.revoked' : 'lend.endedWhy.timeout') });
}

/** The note a lend ended with, in words (only ever my own two constants: never text from the other PC). Null when it has none. */
export function endNoteWords(g: Pick<Grant, 'direction' | 'end_note'>): string | null {
  if (g.end_note === 'borrower restarted') return t(g.direction === 'out' ? 'lend.endedWhy.borrowerRestart' : 'lend.endedWhy.myRestart');
  if (g.end_note === 'not held') return g.direction === 'out' ? t('lend.endedWhy.notHeld') : null;
  if (g.end_note === 'lender restarted') return t(g.direction === 'out' ? 'lend.endedWhy.myRestart' : 'lend.endedWhy.theirRestart');
  return null;
}

export function endedWords(g: Grant): string {
  const base = g.end_reason === 'revoked' ? t('lend.end.revoked') : g.end_reason === 'returned' ? t('lend.end.returned') : t('lend.end.timeout');
  const note = endNoteWords(g);
  return note ? `${base} · ${note}` : base;
}

/** The two messages that come before a grant ends. */
export const WARN_TEN = { minutes: 10 } as const;
export const WARN_ONE = { minutes: 1 } as const;

/** The box shown when lending to another person. The text is the founder's (plan, section 4). */
export function otherPersonWarning(agent: string): { head: string; lines: string[]; tick: string } {
  return {
    head: t('lend.risk.head'),
    lines: [t('lend.risk.l1', { agent }), t('lend.risk.l2'), t('lend.risk.l3'), t('lend.risk.l4')],
    tick: t('lend.risk.tick'),
  };
}

export const errText = (err: unknown): string => (errorSentence(err));

/**
 * Which switch a refused borrow is about, from the other PC's own words: its "Lend an agent" (off there), or
 * "Borrow my agent sign-ins" for this PC (off there). Null for any other failure. The far side is the only place
 * these two can be read: nothing is asked of it before the ask, and nothing is changed there from here.
 */
export type RefusedSwitch = 'otherGlobal' | 'otherDevice';

export function refusedSwitch(err: unknown): RefusedSwitch | null {
  const text = errText(err);
  if (/does not let this PC borrow yet/i.test(text)) return 'otherDevice';
  if (/lending is off on this pc/i.test(text)) return 'otherGlobal';
  if (/borrow my agent sign-ins/i.test(text)) return 'otherDevice';
  return null;
}

/** A reason from another PC, always shown in quotes. */
export const quoted = (text: string): string => `“${text}”`;

/** The first line of the chip's details: "Claude · Ren's Work account (borrowed)". */
export function chipLabelOf(g: Grant, agent: string): string {
  return borrowedName(agent, g);
}

/**
 * The line shown on a borrowed sign-in (pane chip, Active lends). The agent can only see a placeholder key and the lender's
 * address, so it may say "API billing" or "API key" even when the lender lends a plan: say what is true.
 */
export function borrowedBillingNote(peerName: string): string {
  return t('lend.billingNote', { peer: peerName });
}
