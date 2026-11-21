import { describe, expect, it } from 'vitest';
import type { UsageRow } from '../../../lib/usage';
import { ownSignedState, type OwnLogin } from './ownSignIn';

const row = { id: 'claude', label: 'Claude', state: 'ready' };
const login = (state: OwnLogin['state'], why: string | null = null): OwnLogin[] => [{ agent_id: 'claude', state, why }];
const usage = (state: UsageRow['state']): UsageRow[] => [{ agent_id: 'claude', label: 'Claude', account_id: null, account_label: null, state, reason: null, windows: [], plan: null, observed_at_ms: null, limited_until_ms: null, page: null }];

describe('ownSignedState', () => {
  it('a found login is Signed in, and an expired usage row turns it into Not signed in with the reason', () => {
    expect(ownSignedState(row, login('signed_in'), []).kind).toBe('in');
    expect(ownSignedState(row, login('signed_in'), usage('ok')).kind).toBe('in');
    const expired = ownSignedState(row, login('signed_in'), usage('expired'));
    expect(expired.kind).toBe('out');
    expect(expired.why).toContain('ran out');
  });
  it('no login found is Not signed in', () => {
    expect(ownSignedState(row, login('signed_out'), []).kind).toBe('out');
  });
  it('unknown is Can\'t tell with the desktop\'s reason, unless the health check already wants a sign-in', () => {
    const cant = ownSignedState(row, login('unknown', 'Claude keeps its sign-in where this app cannot look.'), []);
    expect(cant).toEqual({ kind: 'cant', why: 'Claude keeps its sign-in where this app cannot look.' });
    expect(ownSignedState({ ...row, state: 'needs_login' }, login('unknown', 'x'), []).kind).toBe('out');
  });
  it('no answer at all (not asked yet, or the agent cannot be checked) is Can\'t tell, never Signed in', () => {
    expect(ownSignedState(row, null, []).kind).toBe('cant');
    const none = ownSignedState(row, [], []);
    expect(none.kind).toBe('cant');
    expect(none.why).toContain('Claude');
  });
  it('another agent\'s answer does not count', () => {
    expect(ownSignedState(row, [{ agent_id: 'codex', state: 'signed_in', why: null }], []).kind).toBe('cant');
  });
});
