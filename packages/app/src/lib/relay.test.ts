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
  it('is none for no status, a quick address, or an address that is not a workers.dev Worker', () => {
    expect(oneRelay(null)).toBeNull();
    expect(oneRelay(status({ mode: 'quick' }))).toBeNull();
    expect(oneRelay(status({ url: 'https://relay.example.com' }))).toBeNull();
    expect(oneRelay(status({ url: null }))).toBeNull();
  });
});

describe('relayUsers', () => {
  const relay = { address: 'https://pm-relay.maya.workers.dev', host: 'pm-relay.maya.workers.dev', link: 'linked' as const };
  it('lists the phone, and the team only when its relay is this same Worker', () => {
    expect(relayUsers(relay, '')).toEqual(['phone']);
    expect(relayUsers(relay, 'https://pm-relay.maya.workers.dev/')).toEqual(['phone', 'team']);
    expect(relayUsers(relay, 'https://other.workers.dev')).toEqual(['phone']);
  });
  it('lists nobody when there is no relay', () => {
    expect(relayUsers(null, 'https://pm-relay.maya.workers.dev')).toEqual([]);
  });
});
