import { describe, expect, it } from 'vitest';
import { GRANT_IN, GRANT_IN_PANE, GRANT_OUT, LEND_DRIVERS, REQUEST_MAYA } from '../dev/lend-fixtures';
import {
  agentLabel,
  borrowedName,
  borrowedShort,
  capFor,
  cleanName,
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
  signInProblem,
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

  it('offers verified and lab agents only, Codex and Gemini included, and nothing is coming soon', () => {
    expect(offerable(LEND_DRIVERS).map((d) => d.agent_id)).toEqual(['claude', 'codex', 'gemini']);
    const cursor = { agent_id: 'cursor', label: 'Cursor', support: 'no' as const, api_key: false, account: false, chat: false };
    expect(offerable([...LEND_DRIVERS, cursor]).map((d) => d.agent_id)).toEqual(['claude', 'codex', 'gemini']);
    expect(comingSoonAgents(LEND_DRIVERS)).toEqual([]);
    expect(agentLabel({ drivers: LEND_DRIVERS }, 'claude')).toBe('Claude');
    expect(agentLabel(null, 'zed')).toBe('Zed');
  });

  it('says in plain words why a sign-in cannot be lent for an agent, and only then', () => {
    expect(signInProblem(LEND_DRIVERS, ['claude'])).toBeNull();
    expect(signInProblem(LEND_DRIVERS, [])).toBeNull();
    expect(signInProblem(LEND_DRIVERS, ['codex'])).toBe('Codex signed in with ChatGPT is not supported yet. Only an OpenAI API key can be lent.');
    // One agent without a lendable sign-in is enough to turn it off for the whole profile.
    expect(signInProblem(LEND_DRIVERS, ['claude', 'gemini'])).toContain('Google is not supported yet');
    // No note from the backend: a generic sentence, never a blank.
    const bare = [{ agent_id: 'x', label: 'Xcli', support: 'lab' as const, api_key: true, account: false, chat: false }];
    expect(signInProblem(bare, ['x'])).toBe('Xcli can only be lent with an API key.');
  });

  it('words the request, the member row, the menu entry and the chip', () => {
    expect(requestTitle(REQUEST_MAYA, 'Claude')).toBe("Maya's laptop wants Claude for 8 hours");
    const now = GRANT_OUT.started_ms + 5 * MIN;
    expect(grantLine(GRANT_OUT, 'Claude', GRANT_OUT.ends_ms - (2 * 3600_000 + 14 * MIN))).toBe('Lending Claude to Maya · 2h 14m left');
    expect(grantLine(GRANT_IN, 'Claude', GRANT_IN.ends_ms - 40 * MIN)).toBe('Borrowing Claude from Sam · 40m left');
    expect(chipText(GRANT_IN_PANE, 'Claude', GRANT_IN_PANE.ends_ms - 119 * MIN)).toBe('Work account · 1h 59m');
    // The lender sent no name (an older build): the old short form.
    expect(chipText({ ...GRANT_IN_PANE, profile_name: undefined }, 'Claude', GRANT_IN_PANE.ends_ms - 119 * MIN)).toBe("Leo's Claude · 1h 59m");
    // The lender's PC is not answering: the chip says so instead of the time.
    expect(chipText({ ...GRANT_IN_PANE, problem: 'x', problem_kind: 'unreachable' }, 'Claude', GRANT_IN_PANE.ends_ms - 119 * MIN)).toBe('Work account · not answering');
    expect(isActiveIn(GRANT_IN, now)).toBe(true);
    expect(isActiveIn({ ...GRANT_IN, state: 'ended' }, now)).toBe(false);
  });

  it('says what a lend used, its limits, and the one sentence for an expired lender sign-in', () => {
    expect(usageText({ requests: 14, input_tokens: 52_300, output_tokens: 9_800 })).toBe('14 requests');
    expect(usageText({ requests: 1, input_tokens: 5, output_tokens: 7 })).toBe('1 request');
    expect(usageText({ requests: 0, input_tokens: 0, output_tokens: 0 })).toBeNull();
    expect(usageText({})).toBeNull();
    expect(limitsText({ max_requests: 200, max_tokens: 500_000 })).toBe('Up to 200 requests');
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

describe('the borrowed name (one helper, used everywhere)', () => {
  const ren = { peer_name: 'Ren', peer_device_name: "Ren's laptop", for_other_person: true, profile_name: 'Work account' };

  it('normal: "Claude · Ren\'s Work account (borrowed)"', () => {
    expect(borrowedName('Claude', ren)).toBe("Claude · Ren's Work account (borrowed)");
    expect(borrowedShort('Claude', ren)).toBe("Ren's Work account");
  });

  it('a profile name that already starts with the owner is not prefixed again', () => {
    const named = { ...ren, profile_name: "Ren's work account" };
    expect(borrowedName('Claude', named)).toBe("Claude · Ren's work account (borrowed)");
    expect(borrowedShort('Claude', named)).toBe("Ren's work account");
  });

  it('from my own other PC: "Claude · Work account on Desk-PC (borrowed)"', () => {
    const mine = { ...ren, peer_name: 'Leo', peer_device_name: 'Desk-PC', for_other_person: false };
    expect(borrowedName('Claude', mine)).toBe('Claude · Work account on Desk-PC (borrowed)');
    expect(borrowedShort('Claude', mine)).toBe('Work account');
  });

  it('an older lender sent no name: "Claude · Ren\'s PC (borrowed)"', () => {
    expect(borrowedName('Claude', { ...ren, profile_name: undefined })).toBe("Claude · Ren's PC (borrowed)");
    expect(borrowedName('Claude', { ...ren, profile_name: '   ' })).toBe("Claude · Ren's PC (borrowed)");
    expect(borrowedShort('Claude', { ...ren, profile_name: undefined })).toBe("Ren's Claude");
  });

  it('a long or dirty name from another PC is cut to 60 plain characters', () => {
    const dirty = `Work\naccount\u0007 ${'x'.repeat(200)}`;
    const cut = cleanName(dirty);
    expect([...cut]).toHaveLength(60);
    expect(cut.startsWith('Work account xxx')).toBe(true);
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001f]/.test(cut)).toBe(false);
    expect(borrowedName('Claude', { ...ren, profile_name: dirty })).toContain("Ren's Work account xxx");
    expect(cleanName(null)).toBe('');
  });

  it('words the problem by its kind, and an older build (no kind) keeps the old sentence', () => {
    const base = { problem: 'x', peer_name: 'Ren', profile_name: 'Work account' };
    expect(problemText({ ...base, problem_kind: 'unreachable' })).toBe("Ren's PC is not answering. It may be asleep or offline. The time keeps running.");
    expect(problemText({ ...base, problem_kind: 'signin', direction: 'in' })).toBe("Ren's Work account is signed out on Ren's PC. Ren has been told. It will carry on when Ren signs in again.");
    expect(problemText({ ...base, problem_kind: 'signin', direction: 'out', peer_name: 'Maya' })).toBe('Work account is signed out. Maya cannot use it until you sign in again.');
    expect(problemText({ ...base, problem_kind: 'limit' })).toBe('The limit for this lend was reached. Ask Ren for more.');
    expect(problemText({ problem: 'sign-in expired' })).toBe("The lender's sign-in expired. Ask them to sign in again.");
    expect(problemText({ problem: null, problem_kind: 'unreachable' })).toBeNull();
  });

  it('the lines name the profile when there is one', () => {
    expect(grantLine({ ...GRANT_OUT, profile_name: 'Work account' }, 'Claude', GRANT_OUT.ends_ms - 8 * 3600_000)).toBe('Lending Work account to Maya · 8h 0m left');
    expect(grantLine({ ...GRANT_IN, profile_name: 'Work account' }, 'Claude', GRANT_IN.ends_ms - 40 * MIN)).toBe("Claude · Sam's Work account (borrowed) · 40m left");
  });
});
