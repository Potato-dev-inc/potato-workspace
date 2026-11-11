import { describe, expect, it } from 'vitest';
import { GRANT_IN, GRANT_IN_PANE, GRANT_OUT, LEND_DRIVERS, REQUEST_MAYA } from '../dev/lend-fixtures';
import {
  agentLabel,
  capFor,
  chipText,
  comingSoonAgents,
  customSecs,
  durationProblem,
  durationWords,
  grantLine,
  isActiveIn,
  leftText,
  lendEnabled,
  limitsText,
  offerable,
  otherPersonWarning,
  problemText,
  requestTitle,
  urgencyOf,
  usageText,
} from './lend';

const MIN = 60_000;

describe('lend rules', () => {
  it('names a length in plain words', () => {
    expect(durationWords(3600)).toBe('1 hour');
    expect(durationWords(8 * 3600)).toBe('8 hours');
    expect(durationWords(5400)).toBe('1 h 30 min');
    expect(durationWords(45 * 60)).toBe('45 min');
    expect(durationWords(7 * 86400)).toBe('7 days');
  });

  it('reads the Custom field as hours and minutes, and anything odd as zero', () => {
    expect(customSecs('1', '30')).toBe(5400);
    expect(customSecs('', '45')).toBe(2700);
    expect(customSecs('x', '')).toBe(0);
    expect(customSecs('-1', '0')).toBe(0);
  });

  it('caps a lend at 7 days, or 24 hours for another person', () => {
    expect(capFor(false)).toBe(7 * 86400);
    expect(capFor(true)).toBe(86400);
    expect(durationProblem(7 * 86400, false)).toBeNull();
    expect(durationProblem(7 * 86400 + 60, false)).toMatch(/7 days/);
    expect(durationProblem(86400, true)).toBeNull();
    expect(durationProblem(86400 + 60, true)).toMatch(/24 hours/);
    expect(durationProblem(30, false)).toMatch(/one minute/);
  });

  it('shows time left, and turns amber at 10 minutes and red at 1', () => {
    expect(leftText(2 * 3600_000 + 14 * MIN)).toBe('2h 14m');
    expect(leftText(40 * MIN)).toBe('40m');
    expect(leftText(30_000)).toBe('1m');
    expect(leftText(0)).toBe('ended');
    expect(urgencyOf(11 * MIN)).toBe('calm');
    expect(urgencyOf(10 * MIN)).toBe('soon');
    expect(urgencyOf(61_000)).toBe('soon');
    expect(urgencyOf(60_000)).toBe('now');
  });

  it('offers verified and lab agents only, and lists Codex as coming soon', () => {
    expect(offerable(LEND_DRIVERS).map((d) => d.agent_id)).toEqual(['claude']);
    expect(offerable([...LEND_DRIVERS, { agent_id: 'cursor', label: 'Cursor', support: 'no' }]).map((d) => d.agent_id)).toEqual(['claude']);
    expect(comingSoonAgents(LEND_DRIVERS).map((c) => c.label)).toEqual(['Codex']);
    // Once Codex has a driver it is offered, not "coming soon".
    expect(comingSoonAgents([...LEND_DRIVERS, { agent_id: 'codex', label: 'Codex', support: 'lab' }])).toEqual([]);
    expect(agentLabel({ drivers: LEND_DRIVERS }, 'claude')).toBe('Claude');
    expect(agentLabel(null, 'zed')).toBe('Zed');
  });

  it('words the request, the member row, the menu entry and the chip', () => {
    expect(requestTitle(REQUEST_MAYA, 'Claude')).toBe("Maya's laptop wants Claude for 8 hours");
    const now = GRANT_OUT.started_ms + 5 * MIN;
    expect(grantLine(GRANT_OUT, 'Claude', GRANT_OUT.ends_ms - (2 * 3600_000 + 14 * MIN))).toBe('Lending Claude to Maya · 2h 14m left');
    expect(grantLine(GRANT_IN, 'Claude', GRANT_IN.ends_ms - 40 * MIN)).toBe('Borrowing Claude from Sam · 40m left');
    expect(chipText(GRANT_IN_PANE, 'Claude', GRANT_IN_PANE.ends_ms - 119 * MIN)).toBe("Leo's Claude · 1h 59m");
    expect(isActiveIn(GRANT_IN, now)).toBe(true);
    expect(isActiveIn({ ...GRANT_IN, state: 'ended' }, now)).toBe(false);
  });

  it('says what a lend used, its limits, and the one sentence for an expired lender sign-in', () => {
    expect(usageText({ requests: 14, input_tokens: 52_300, output_tokens: 9_800 })).toBe('14 requests · 62.1k tokens');
    expect(usageText({ requests: 1, input_tokens: 5, output_tokens: 7 })).toBe('1 request · 12 tokens');
    expect(usageText({ requests: 0, input_tokens: 0, output_tokens: 0 })).toBeNull();
    expect(usageText({})).toBeNull();
    expect(limitsText({ max_requests: 200, max_tokens: 500_000 })).toBe('Up to 200 requests and 500,000 tokens');
    expect(limitsText({ max_requests: null })).toBeNull();
    expect(problemText({ problem: 'sign-in expired' })).toBe("The lender's sign-in expired. Ask them to sign in again.");
    expect(problemText({ problem: null })).toBeNull();
    expect(problemText({})).toBeNull();
  });

  it('keeps "Use at your own risk" in the warning', () => {
    const w = otherPersonWarning('Claude');
    expect(w.head).toContain('Use at your own risk');
    expect(w.lines.join(' ')).toContain('Claude plan');
    expect(w.tick).toBe('I understand');
  });

  it('reads the Labs switch', () => {
    expect(lendEnabled(null)).toBe(false);
    expect(lendEnabled({})).toBe(false);
    expect(lendEnabled({ lend_enabled: true })).toBe(true);
  });
});
