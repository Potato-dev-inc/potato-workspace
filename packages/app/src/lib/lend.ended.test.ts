import { describe, expect, it } from 'vitest';
import { endedNotice, type Grant } from './lend';

const g = (o: Partial<Grant>) => ({ direction: 'in', state: 'ended', end_reason: 'revoked', ...o }) as Grant;

describe('the one line for a lend that ended on its own', () => {
  it('says the lender restarted', () => expect(endedNotice(g({ end_note: 'lender restarted' }))).toBe('Lend ended: the lender\'s PC restarted'));
  it('says this PC restarted on the lender side', () => expect(endedNotice(g({ direction: 'out', end_note: 'lender restarted' }))).toBe('Lend ended: this PC restarted'));
  it('says nothing for what the person did', () => {
    expect(endedNotice(g({ end_reason: 'returned' }))).toBeNull();
    expect(endedNotice(g({ direction: 'out' }))).toBeNull();
  });
  it('says time ran out', () => expect(endedNotice(g({ end_reason: 'expired' }))).toBe('Lend ended: time ran out'));
});
