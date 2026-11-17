// ONE relay per person. The Worker saved for the phone's fixed address is the relay for everything on Connect: the
// phone, the team (and lending requests, which travel on the team relay). This file only decides which address that
// is and how it is doing. It reads the saved tunnel setting and never touches a secret: every feature keeps its own.
import type { TunnelStatus } from './tauri-types';
import { workersDevAddress } from './worker';

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
  const address = workersDevAddress(status.config.url);
  if (!address) return null;
  const link = status.stable?.link ?? 'waiting';
  return { address, host: address.replace(/^https:\/\//, ''), link };
}

/** Which Connect tabs use this relay now: the phone always; the team when its relay is this same Worker. */
export function relayUsers(relay: OneRelay | null, teamRelay: string | null | undefined): Array<'phone' | 'team'> {
  if (!relay) return [];
  const users: Array<'phone' | 'team'> = ['phone'];
  if (workersDevAddress(teamRelay) === relay.address) users.push('team');
  return users;
}
