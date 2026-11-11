import { describe, expect, it } from 'vitest';
import { formatCode, parsePastedInvite } from './team-invite';

const LINK = 'pm://team/join?v=1&t=team-7f3a&n=Acme&k=8Vh2mQ0pXn4c';

describe('parsePastedInvite', () => {
  it('finds a bare link', () => {
    expect(parsePastedInvite(LINK)).toEqual({ link: LINK, code: null });
  });

  it('finds the link inside a message, and drops the full stop after it', () => {
    expect(parsePastedInvite(`Hi! Join my team here: ${LINK}. See you soon`).link).toBe(LINK);
    expect(parsePastedInvite(`(${LINK})`).link).toBe(LINK);
    expect(parsePastedInvite(`line one\n${LINK}\nline three`).link).toBe(LINK);
  });

  it('finds the code too when it comes in the same text', () => {
    expect(parsePastedInvite(`${LINK}\nCode: kq7m-4xpd`).code).toBe('KQ7M-4XPD');
    expect(parsePastedInvite(`${LINK} code kq7m 4xpd`).code).toBe('KQ7M-4XPD');
    expect(parsePastedInvite(`${LINK} my code is KQ7M4XPD`).code).toBe('KQ7M-4XPD');
  });

  it('does not take ordinary words for a code', () => {
    expect(parsePastedInvite(`Please join our team ${LINK} thanks`).code).toBeNull();
  });

  it('finds nothing in text without an invite', () => {
    expect(parsePastedInvite('hello there')).toEqual({ link: null, code: null });
    expect(parsePastedInvite('https://example.com/join')).toEqual({ link: null, code: null });
  });
});

describe('formatCode', () => {
  it('shows ABCD-EFGH while typing', () => {
    expect(formatCode('abcd')).toBe('ABCD');
    expect(formatCode('abcde')).toBe('ABCD-E');
    expect(formatCode('abcd efgh jk')).toBe('ABCD-EFGH');
  });
});
