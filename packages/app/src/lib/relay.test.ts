import { describe, expect, it } from 'vitest';
import { oneRelay, relayUsers } from './relay';
import type { TunnelStatus } from './tauri-types';

const status = (over: { url?: string | null; mode?: string; stable?: TunnelStatus['stable'] }): TunnelStatus =>
  ({
    mode: over.mode ?? 'stable',
    public_url: null,
    state: 'running',
    error: null,
    config: { mode: over.mode ?? 'stable', hostname: null, url: over.url === undefined ? 'https://pm-relay.maya.workers.dev/' : over.url, has_token: false, has_secret: true },
    stable: over.stable,
  }) as TunnelStatus;

describe('oneRelay', () => {
  it('reads the saved Worker and its link state', () => {
    const r = oneRelay(status({ stable: { worker_url: 'https://pm-relay.maya.workers.dev', quick_url: null, link: 'linked', error: null } }));
    expect(r).toEqual({ address: 'https://pm-relay.maya.workers.dev', host: 'pm-relay.maya.workers.dev', link: 'linked' });
  });
  it('is waiting when the link has not reported yet', () => {
    expect(oneRelay(status({}))?.link).toBe('waiting');
  });
  it('is none for no status, a quick address, or an address that is not an https origin', () => {
    expect(oneRelay(null)).toBeNull();
    expect(oneRelay(status({ mode: 'quick' }))).toBeNull();
    expect(oneRelay(status({ url: 'http://relay.example.com' }))).toBeNull();
    expect(oneRelay(status({ url: 'https://relay.example.com/some/path' }))).toBeNull();
    expect(oneRelay(status({ url: null }))).toBeNull();
  });
});

it('a Worker on an own domain is the relay too (the permanent address is whatever the person saved)', () => {
  expect(oneRelay(status({ url: 'https://relay.example.com/' }))?.address).toBe('https://relay.example.com');
  expect(oneRelay(status({ url: 'https://relay.example.com/' }))?.host).toBe('relay.example.com');
});

describe('relayUsers', () => {
  const relay = { address: 'https://pm-relay.maya.workers.dev', host: 'pm-relay.maya.workers.dev', link: 'linked' as const };
  const team = 'https://pm-relay.maya.workers.dev/';
  it('lists only what really uses it', () => {
    expect(relayUsers(relay, team)).toEqual([]);
    expect(relayUsers(relay, '', { phones: true })).toEqual(['phone']);
    expect(relayUsers(relay, team, { phones: true, teamActive: true, lendRules: true })).toEqual(['phone', 'team', 'lending']);
    expect(relayUsers(relay, team, { teamActive: true })).toEqual(['team']);
    expect(relayUsers(relay, team, { phones: true, pcs: true })).toEqual(['phone', 'pcs']);
  });
  it('team and lending count only when the team relay is this same Worker', () => {
    expect(relayUsers(relay, 'https://other.workers.dev', { phones: true, teamActive: true, lendRules: true })).toEqual(['phone']);
  });
  it('lists nobody when there is no relay', () => {
    expect(relayUsers(null, 'https://pm-relay.maya.workers.dev')).toEqual([]);
  });
});
