import { describe, expect, it } from 'vitest';
import { pcReach } from './account';

describe('pcReach: the live link is the truth for a paired PC', () => {
  it('a paired PC the account saw a minute ago but whose link is down is not online', () => {
    for (const link of ['offline', 'asleep', 'closed']) expect(pcReach({ status: 'away', online: true }, link)).toBe('cant_reach');
    expect(pcReach({ status: 'away', online: false }, 'offline')).toBe('offline');
  });
  it('a working link is online whatever the account says', () => {
    expect(pcReach({ status: 'away', online: false }, 'online')).toBe('online');
    expect(pcReach({ status: 'online', online: false }, 'offline')).toBe('online');
  });
  it('with no live word the account stands, and a PC that is not paired yet has no link to ask', () => {
    expect(pcReach({ status: 'away', online: true }, undefined)).toBe('online');
    expect(pcReach({ status: 'away', online: true }, 'unknown')).toBe('online');
    expect(pcReach({ status: 'new', online: true }, 'offline')).toBe('online');
    expect(pcReach({ status: 'allow_there', online: true }, 'online')).toBe('offline');
  });
});
