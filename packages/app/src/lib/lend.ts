// Lend through my PC (Labs `lend_enabled`, off by default): lend an agent sign-in to another PC, or borrow one.
//
// The Rust side (src-tauri/src/capacity_proxy) holds everything; this file is the typed command surface and the copy.
// The lender's sign-in never leaves the lender's PC: a grant says who, which agent and until when. A borrowed grant is
// one more sign-in for the borrower (`lend:<grant id>`, see lib/accounts.ts). A request that arrives from a teammate is
// untrusted data (rendered as plain text, the reason always in quotes).
import { errorSentence } from './sayError';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
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
}

export type GrantEnd = 'expired' | 'revoked' | 'returned';

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

export interface LendApi {
  state: () => Promise<LendState>;
  profileSave: (profile: LendProfile) => Promise<LendProfile>;
  profileDelete: (id: string) => Promise<void>;
  request: (memberId: string, deviceId: string | null, agentId: string, secs: number, reason: string) => Promise<LendRequest>;
  answer: (requestId: string, accept: boolean, profileId: string | null, secs: number | null) => Promise<Grant | null>;
  revoke: (grantId: string) => Promise<void>;
  giveBack: (grantId: string) => Promise<void>;
  /** Test link: opens the real link handshake to the other PC and reports. Absent from an older backend. */
  testLink?: (grantId: string) => Promise<LinkTest>;
  startAgent: (grantId: string, projectPath: string) => Promise<{ pane_id: string }>;
  /** A new lend sign-in: an app-managed account folder for `agentId`, marked lend-only. Sign in to it once in a pane. */
  accountAdd: (agentId: string, label: string) => Promise<Account>;
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
  request: (memberId, deviceId, agentId, secs, reason) =>
    call('lend_request', { member_id: memberId, device_id: deviceId, agent_id: agentId, secs, reason }),
  answer: (requestId, accept, profileId, secs) => call('lend_answer', { request_id: requestId, accept, profile_id: profileId, secs }),
  revoke: (grantId) => call('lend_revoke', { grant_id: grantId }),
  giveBack: (grantId) => call('lend_return', { grant_id: grantId }),
  testLink: (grantId) => call('lend_test_link', { grant_id: grantId }),
  startAgent: (grantId, projectPath) => call('lend_start_agent', { grant_id: grantId, project_path: projectPath }),
  accountAdd: (agentId, label) => call('lend_account_add', { agent_id: agentId, label }),
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
  if (s % (24 * HOUR) === 0 && s >= 24 * HOUR * 2) return `${s / (24 * HOUR)} days`;
  const h = Math.floor(s / HOUR);
  const m = Math.round((s % HOUR) / 60);
  if (h === 0) return `${m} min`;
  if (m === 0) return h === 1 ? '1 hour' : `${h} hours`;
  return `${h} h ${m} min`;
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
  if (secs < 60) return 'Pick at least one minute.';
  const cap = capFor(forOtherPerson);
  if (secs > cap) return forOtherPerson ? 'Another person can borrow it for 24 hours at most.' : 'The most is 7 days.';
  return null;
}

/** "2h 14m", "40m", "1m" (the last minute), "3d 2h". The time left on a grant. */
export function leftText(ms: number): string {
  if (ms <= 0) return 'ended';
  const total = Math.ceil(ms / 60_000);
  if (total < 1) return '<1m';
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export type Urgency = 'calm' | 'soon' | 'now';
/** The chip turns amber at 10 minutes and red at 1. */
export function urgencyOf(msLeft: number): Urgency {
  if (msLeft <= 60_000) return 'now';
  if (msLeft <= 10 * 60_000) return 'soon';
  return 'calm';
}

export const isActiveIn = (g: Grant, now: number): boolean => g.direction === 'in' && g.state === 'active' && g.ends_ms > now;
export const isActiveOut = (g: Grant, now: number): boolean => g.direction === 'out' && g.state === 'active' && g.ends_ms > now;

/** The agent's name from the driver list, else the id with a capital. */
export function agentLabel(state: Pick<LendState, 'drivers'> | null | undefined, id: string): string {
  const hit = state?.drivers.find((d) => d.agent_id === id)?.label;
  return hit ?? (id ? id[0].toUpperCase() + id.slice(1) : 'agent');
}

/** Agents a person may ask for or lend: verified, or lab (tagged). `no` is never offered. */
export function offerable(drivers: readonly LendDriver[]): LendDriver[] {
  return drivers.filter((d) => d.support !== 'no');
}

/** Agents shown in the lists as "<Agent>: coming soon" and never offered. None today: Codex and Gemini lend with an API key. */
export const COMING_SOON: readonly { agent_id: string; label: string }[] = [];

export const comingSoonText = (label: string): string => `${label}: coming soon`;

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
  return blocked.account_note || `${blocked.label} can only be lent with an API key.`;
}

export const supportTag = (s: Support): string => (s === 'verified' ? 'Works' : s === 'lab' ? 'Lab' : 'Not possible');

/** "Leo's laptop": a device name that already starts with the owner is kept as it is. */
export function ownerOf(person: string, device: string): string {
  return device.toLowerCase().startsWith(person.toLowerCase()) ? device : `${person}'s ${device}`;
}

/** "Leo's laptop wants Claude for 8 hours". */
export function requestTitle(r: LendRequest, agent: string): string {
  const who = r.device_name ? ownerOf(r.member_name, r.device_name) : r.member_name;
  return `${who} wants ${agent} for ${durationWords(r.secs)}`;
}

/** "Lending Claude to Maya · 2h 14m left" / "Borrowing Codex from Leo · 40m left". */
export function grantLine(g: Grant, agent: string, now: number): string {
  const left = `${leftText(g.ends_ms - now)} left`;
  return g.direction === 'out' ? `Lending ${agent} to ${g.peer_name} · ${left}` : `Borrowing ${agent} from ${g.peer_name} · ${left}`;
}

/** The sentence shown on both PCs when `problem` is set. The Rust side sends its own words; this is the same text. */
export const SIGNIN_PROBLEM_TEXT = "The lender's sign-in expired. Ask them to sign in again.";

/** What to show for a grant's `problem`: the plain sentence, whatever the backend's wording, or null when all is fine. */
export const problemText = (g: Pick<Grant, 'problem'>): string | null => (g.problem ? SIGNIN_PROBLEM_TEXT : null);

/** "12 requests · 3.4k tokens", or null while nothing was used (the borrower's PC may not count). */
export function usageText(g: Pick<Grant, 'requests' | 'input_tokens' | 'output_tokens'>): string | null {
  const requests = g.requests ?? 0;
  const tokens = (g.input_tokens ?? 0) + (g.output_tokens ?? 0);
  if (requests === 0 && tokens === 0) return null;
  const t = tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
  return `${requests} ${requests === 1 ? 'request' : 'requests'} · ${t} tokens`;
}

/** The limits of a profile as one line, or null when it has none. */
export function limitsText(p: Pick<LendProfile, 'max_requests' | 'max_tokens'>): string | null {
  const parts: string[] = [];
  if (p.max_requests) parts.push(`${p.max_requests} requests`);
  if (p.max_tokens) parts.push(`${p.max_tokens.toLocaleString('en-US')} tokens`);
  return parts.length > 0 ? `Up to ${parts.join(' and ')}` : null;
}

/** The pane chip: "Leo's Claude · 1h 59m". */
export function chipText(g: Grant, agent: string, now: number): string {
  return `${g.peer_name}'s ${agent} · ${leftText(g.ends_ms - now)}`;
}

/** Why a grant ended, in a plain sentence. */
export function endedWords(g: Grant): string {
  if (g.end_reason === 'revoked') return 'Taken back';
  if (g.end_reason === 'returned') return 'Given back';
  return 'Time ran out';
}

/** The two messages that come before a grant ends. */
export const WARN_TEN = { minutes: 10, text: 'Finish or save now' } as const;
export const WARN_ONE = { minutes: 1, text: 'Finish or save now' } as const;

/** The box shown when lending to another person. The text is the founder's (plan, section 4). */
export function otherPersonWarning(agent: string): { head: string; lines: string[]; tick: string } {
  return {
    head: 'You are lending to another person. Use at your own risk.',
    lines: [
      `They will use your ${agent} plan as you. Your provider may not allow sharing and may limit or close your account.`,
      '"Send my login": they get a copy of your sign-in. It keeps working until you sign it out. Potato Workspace cannot take it back.',
      '"Through my PC": your PC can see what they send.',
      'Lend only to people you trust.',
    ],
    tick: 'I understand',
  };
}

export const errText = (err: unknown): string => (errorSentence(err));

/** A reason from another PC, always shown in quotes. */
export const quoted = (text: string): string => `“${text}”`;

/** The first line of the chip's details: "Borrowed Claude from Leo's PC". */
export function chipLabelOf(g: Grant, agent: string): string {
  return `Borrowed ${agent} from ${ownerOf(g.peer_name, g.peer_device_name || 'PC')}`;
}

/**
 * The line shown on a borrowed sign-in (pane chip, Active lends). The agent can only see a placeholder key and the lender's
 * address, so it may say "API billing" or "API key" even when the lender lends a plan: say what is true.
 */
export function borrowedBillingNote(peerName: string): string {
  return `This is ${peerName}'s sign-in, lent through their PC. The agent may say "API billing"; that is only how it is connected. Use is charged to ${peerName}'s plan, not yours.`;
}
