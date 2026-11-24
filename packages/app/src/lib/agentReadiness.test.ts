import { describe, expect, it } from 'vitest';
import { useEnglish } from '../i18n/test-utils';
import { agentReadiness, type ReadinessSources, type ReadinessState } from './agentReadiness';

useEnglish();

const AT = new Date(2026, 10, 24, 14, 24).getTime();
const h = (over: Partial<NonNullable<ReadinessSources['health']>[number]> = {}) => ({ id: 'cursor', label: 'Cursor', installed: true, state: 'unchecked' as const, reason: '', can_test: true, ...over });
const login = (state: 'signed_in' | 'signed_out' | 'unknown') => [{ agent_id: 'cursor', state, why: null }];
const test = (state: 'ready' | 'needs_login' | 'error') => ({ cursor: { state, reason: state === 'error' ? 'Timed out.' : '', at: AT } });

// One row per combination of what is known: the one answer every screen shows.
const TABLE: Array<[string, ReadinessSources, ReadinessState]> = [
  ['not installed', { health: [h({ installed: false, state: 'not_installed' })], logins: [] }, 'not_installed'],
  ['nothing known', { logins: null }, 'not_checked'],
  ['quick check only', { health: [h({ state: 'ready' })], logins: null }, 'not_checked'],
  ['login read: signed in, never tested (Cursor row vs header)', { health: [h()], logins: login('signed_in') }, 'signed_in'],
  ['login read: signed out', { health: [h()], logins: login('signed_out') }, 'needs_sign_in'],
  ['login unknown, never tested', { health: [h()], logins: login('unknown') }, 'not_checked'],
  ['quick says needs login', { health: [h({ state: 'needs_login' })], logins: login('unknown') }, 'needs_sign_in'],
  ['tested ok (Claude: Overview says works)', { health: [h()], logins: null, tests: test('ready') }, 'ready'],
  ['tested ok and signed in', { health: [h()], logins: login('signed_in'), tests: test('ready') }, 'ready'],
  ['tested ok but the login is gone', { health: [h()], logins: login('signed_out'), tests: test('ready') }, 'needs_sign_in'],
  ['tested: needs login, login read says signed in (the Codex flip: the login read wins)', { health: [h()], logins: login('signed_in'), tests: test('needs_login') }, 'signed_in'],
  ['tested: needs login, login unknown', { health: [h()], logins: login('unknown'), tests: test('needs_login') }, 'needs_sign_in'],
  ['tested: failed', { health: [h()], logins: login('signed_in'), tests: test('error') }, 'broken'],
  ['did not start', { health: [h({ state: 'error', reason: 'exit code 1' })], logins: login('signed_in'), tests: test('ready') }, 'broken'],
  ['cannot be tested, starts', { health: [h({ state: 'ready', can_test: false })], logins: null }, 'ready'],
];

describe('agentReadiness', () => {
  it.each(TABLE)('%s', (_name, src, state) => {
    expect(agentReadiness('cursor', src).state).toBe(state);
  });

  it('says the same words for the same state, and the time of the Test', () => {
    expect(agentReadiness('cursor', { health: [h()], logins: login('signed_in') }).label).toBe('Signed in');
    expect(agentReadiness('cursor', { health: [h()], logins: login('signed_out') }).label).toBe('Not signed in');
    const ok = agentReadiness('cursor', { health: [h()], logins: null, tests: test('ready') });
    expect(ok.label).toBe('Ready');
    expect(ok.detail).toMatch(/^Tested /);
    expect(ok.at).toBe(AT);
    expect(agentReadiness('cursor', { health: [h()], logins: null }).label).toBe('Not checked yet');
  });

  it('a usage row that ran out turns a found login into not signed in, with the reason', () => {
    const r = agentReadiness('cursor', { health: [h()], logins: login('signed_in'), usage: [{ agent_id: 'cursor', account_id: null, state: 'expired' } as never] });
    expect(r).toMatchObject({ state: 'needs_sign_in', detail: 'The sign-in ran out. Sign in again.' });
  });

  it('another agent login answer does not count', () => {
    expect(agentReadiness('cursor', { health: [h()], logins: [{ agent_id: 'codex', state: 'signed_in', why: null }] }).state).toBe('not_checked');
  });

  it('a login that could not be read says why it cannot tell', () => {
    expect(agentReadiness('cursor', { health: [h()], logins: null }).detail).toBe('Could not check yet.');
    expect(agentReadiness('cursor', { health: [h()], logins: [] }).detail).toBe('This app has no way to check Cursor.');
  });
});
