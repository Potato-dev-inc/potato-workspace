import { describe, expect, it } from 'vitest';
import { verdictFor, workersDevAddress } from './worker';

describe('Worker features', () => {
  const health = (features: string[], reachable = true) => ({ reachable, features, legacyLink: false });
  it('says ok, update, unreachable or unknown', () => {
    expect(verdictFor(health(['team', 'stable-link']), 'stable-link')).toBe('ok');
    expect(verdictFor(health(['team']), 'stable-link')).toBe('update');
    expect(verdictFor(health([], false), 'team')).toBe('unreachable');
    expect(verdictFor(null, 'team')).toBe('unknown');
  });
  it('only a plain workers.dev address counts as a saved Worker', () => {
    expect(workersDevAddress('https://pm-relay.me.workers.dev/')).toBe('https://pm-relay.me.workers.dev');
    for (const bad of [null, '', 'https://relay.acme.dev', 'http://a.workers.dev', 'https://a.workers.dev/pm', 'https://a.workers.dev:8443', 'https://evil.com/.workers.dev']) {
      expect(workersDevAddress(bad), String(bad)).toBeNull();
    }
  });
});
