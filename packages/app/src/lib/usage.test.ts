// The words and the tooltip of the "Used" strip, from SYNTHETIC rows.
import { describe, expect, it } from 'vitest';
import { chipText, formatLeft, headline, loginReadsOn, rowName, tightestFirst, tooltip, usageBarOn, warns, type UsageRow } from './usage';

const NOW = Date.UTC(2026, 0, 2, 4, 0);
const H = 3_600_000;

function row(over: Partial<UsageRow> = {}): UsageRow {
  return {
    agent_id: 'codex',
    label: 'Codex CLI',
    account_id: null,
    account_label: null,
    state: 'ok',
    reason: null,
    windows: [
      { name: '5-hour', used_percent: 87, minutes: 300, resets_at_ms: NOW + 9 * H + 55 * 60_000, reset_since: false },
      { name: 'Weekly', used_percent: 31, minutes: 10080, resets_at_ms: NOW + 4 * 24 * H, reset_since: false },
    ],
    plan: 'plus',
    observed_at_ms: NOW - 5 * 60_000,
    limited_until_ms: null,
    page: 'https://example.test/usage',
    ...over,
  };
}

describe('usage strip words', () => {
  it('formats the time left like the strip shows it', () => {
    expect(formatLeft(9 * H + 55 * 60_000)).toBe('9h 55m');
    expect(formatLeft(12 * 24 * H + H)).toBe('12d 1h');
    expect(formatLeft(45 * 60_000)).toBe('45m');
    expect(formatLeft(2 * H)).toBe('2h');
    expect(formatLeft(0)).toBe('now');
  });

  it('shows the fullest window with its reset', () => {
    expect(headline(row())?.name).toBe('5-hour');
    expect(chipText(row(), NOW)).toBe('87% used · resets in 9 hours');
  });

  it('says Limit reached, Sign-in expired or Usage not shared instead of numbers', () => {
    expect(chipText(row({ state: 'limited', limited_until_ms: NOW + 2 * H }), NOW)).toBe('Limit reached · resets in 2 hours');
    expect(chipText(row({ state: 'limited' }), NOW)).toBe('Limit reached');
    expect(chipText(row({ state: 'expired', windows: [] }), NOW)).toBe('Sign-in expired');
    expect(chipText(row({ state: 'unknown', windows: [], reason: 'no numbers' }), NOW)).toBe('Usage not shared');
    expect(chipText(row({ state: 'limited', limited_until_ms: NOW + (12 * 24 + 1) * H }), NOW)).toBe('Limit reached · resets in 12 days');
  });

  it('names the sign-in and lists every window, the plan and the reason in the tooltip', () => {
    const tip = tooltip(row({ account_label: 'Work', reason: 'why' }), NOW);
    expect(rowName(row({ account_label: 'Work' }))).toBe('Codex CLI (Work)');
    expect(tip).toContain('Sign-in: Work');
    expect(tip).toContain('Plan: plus');
    expect(tip).toContain('5-hour: 87% used, resets in 9 hours');
    expect(tip).toContain('Weekly: 31% used, resets in 4 days');
    expect(tip).toContain('why');
    expect(tooltip(row(), NOW)).toContain('Sign-in: main login');
    const started = tooltip(row({ windows: [{ name: '5-hour', used_percent: 0, reset_since: true }] }), NOW);
    expect(started).toContain('5-hour: 0% used, started again');
  });

  it('warns at 80 % used, when limited or expired, and orders the tightest first', () => {
    expect(warns(row())).toBe(true);
    const low = row({ windows: [{ name: '5-hour', used_percent: 79.9, reset_since: false }] });
    expect(warns(low)).toBe(false);
    expect(warns(row({ state: 'expired', windows: [] }))).toBe(true);
    const unknown = row({ state: 'unknown', windows: [], label: 'U' });
    const limited = row({ state: 'limited', label: 'L' });
    expect(tightestFirst([unknown, low, row({ label: 'H' }), limited]).map((r) => r.label)).toEqual(['L', 'H', 'Codex CLI', 'U']);
  });

  it('is on unless turned off', () => {
    expect(loginReadsOn({})).toBe(true);
    expect(loginReadsOn({ usage_login_reads: false })).toBe(false);
    expect(usageBarOn(undefined)).toBe(true);
    expect(usageBarOn({})).toBe(true);
    expect(usageBarOn({ show_usage_bar: false })).toBe(false);
  });
});
