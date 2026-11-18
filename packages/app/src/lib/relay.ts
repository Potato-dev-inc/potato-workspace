// ONE relay per person. The Worker saved for the phone's fixed address is the relay for everything on Connect: the
// phone, the team (and lending requests, which travel on the team relay). This file only decides which address that
// is and how it is doing. It reads the saved tunnel setting and never touches a secret: every feature keeps its own.
import type { TunnelStatus } from './tauri-types';
import { permanentAddress, workersDevAddress } from './worker';

export type RelayLink = 'linked' | 'linking' | 'waiting' | 'failed';

export interface OneRelay {
  /** `https://name.workers.dev` */
  address: string;
  host: string;
  link: RelayLink;
}

/** The person's relay from the saved tunnel setting, or null when none is set up yet (a quick or own-domain address is not a Worker). */
export function oneRelay(status: TunnelStatus | null | undefined): OneRelay | null {
  if (!status || status.config.mode !== 'stable') return null;
  // workers.dev or a domain of their own: the permanent address is whatever Worker the person saved.
  const address = permanentAddress(status.config.url);
  if (!address) return null;
  const link = status.stable?.link ?? 'waiting';
  return { address, host: address.replace(/^https:\/\//, ''), link };
}

export type RelayUser = 'phone' | 'team' | 'lending' | 'pcs';

/** What is really using the relay right now (each fact comes from the screen that knows it). */
export interface RelayUse {
  /** At least one phone is paired. */
  phones?: boolean;
  /** A team is running. */
  teamActive?: boolean;
  /** A lend rule (a profile that may be lent) exists. */
  lendRules?: boolean;
  /** PC to PC through the web is on. */
  pcs?: boolean;
}

/** Which parts of Connect use this relay now. Team and lending travel on the team relay, so they count only when that is this same Worker. */
export function relayUsers(relay: OneRelay | null, teamRelay: string | null | undefined, use: RelayUse = {}): RelayUser[] {
  if (!relay) return [];
  const users: RelayUser[] = [];
  const sameTeam = workersDevAddress(teamRelay) === relay.address;
  if (use.phones) users.push('phone');
  if (sameTeam && use.teamActive) users.push('team');
  if (sameTeam && use.lendRules) users.push('lending');
  if (use.pcs) users.push('pcs');
  return users;
}

/** "Checked just now" / "2 min ago" / "3 h ago" as a key + count, so the screen words it (and translates it). */
export function checkedAgo(then: number | null, now: number): { key: 'never' | 'now' | 'min' | 'hour' | 'day'; count: number } {
  if (then === null) return { key: 'never', count: 0 };
  const mins = Math.max(0, Math.floor((now - then) / 60_000));
  if (mins < 1) return { key: 'now', count: 0 };
  if (mins < 60) return { key: 'min', count: mins };
  const hours = Math.floor(mins / 60);
  return hours < 24 ? { key: 'hour', count: hours } : { key: 'day', count: Math.floor(hours / 24) };
}
