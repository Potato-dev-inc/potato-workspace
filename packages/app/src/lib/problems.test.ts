// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { NeedsYouItem } from './attention';
import { clearFixedProblems, fixProblem, openProblems, PROBLEMS_KEY, PROBLEMS_MAX, problemsSnapshot, reportProblem, resetProblems } from './problems';
import { problemsFromNeeds, problemsFromUsage, syncProblems } from './problems-feed';
import type { UsageRow } from './usage';

const base = { agent: 'Claude', agentId: 'claude', paneId: 'p1', way: 'open_chat' as const };

beforeEach(() => {
  window.localStorage.clear();
  resetProblems();
});

describe('the Problems list', () => {
  it('lists newest first, and the same id updates one row instead of adding another', () => {
    reportProblem({ ...base, id: 'a', what: 'first', at: 1 });
    reportProblem({ ...base, id: 'b', what: 'second', at: 2 });
    reportProblem({ ...base, id: 'a', what: 'first again', at: 3 });
    expect(problemsSnapshot().map((p) => p.id)).toEqual(['a', 'b']);
    expect(problemsSnapshot()[0].what).toBe('first again');
  });

  it('a fixed row stays, faded, until Clear; a repeat reopens it', () => {
    reportProblem({ ...base, id: 'a', what: 'x' });
    fixProblem('a');
    expect(openProblems(problemsSnapshot())).toHaveLength(0);
    expect(problemsSnapshot()).toHaveLength(1);
    reportProblem({ ...base, id: 'a', what: 'x' });
    expect(openProblems(problemsSnapshot())).toHaveLength(1);
    fixProblem('a');
    clearFixedProblems();
    expect(problemsSnapshot()).toHaveLength(0);
  });

  it('keeps the last 50 only', () => {
    for (let i = 0; i < PROBLEMS_MAX + 7; i++) reportProblem({ ...base, id: `p${i}`, what: `n${i}`, paneId: null });
    expect(problemsSnapshot()).toHaveLength(PROBLEMS_MAX);
    expect(problemsSnapshot()[0].id).toBe(`p${PROBLEMS_MAX + 6}`);
  });

  it('never keeps a folder path with a user name or a key, in the row or in the stored copy', () => {
    reportProblem({ ...base, id: 'a', what: `Cannot open ${['C:', 'Us' + 'ers', 'sam'].join('\\')}\\work\\app.ts`, details: 'token sk-abcdef123456 in /home/sam/x' });
    const row = problemsSnapshot()[0];
    expect(row.what).not.toContain('sam');
    expect(row.details).not.toContain('sk-abcdef123456');
    expect(row.details).not.toContain('/home/sam');
    const stored = window.localStorage.getItem(PROBLEMS_KEY) ?? '';
    expect(stored).not.toContain('sam');
    expect(stored).not.toContain('sk-abcdef123456');
  });

  it('after a restart the stored rows come back as fixed history, never as open problems', () => {
    reportProblem({ ...base, id: 'a', what: 'x' });
    resetProblems();
    const rows = problemsSnapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0].fixed).toBe(true);
    expect(rows[0].paneId).toBeNull();
  });

  it('a broken stored value is ignored', () => {
    window.localStorage.setItem(PROBLEMS_KEY, '{oops');
    expect(problemsSnapshot()).toEqual([]);
  });
});

describe('where the rows come from', () => {
  const items: NeedsYouItem[] = [
    { id: 'error:p1', kind: 'error', paneId: 'p1', since: 5 },
    { id: 'stuck:p2', kind: 'stuck', paneId: 'p2' },
    { id: 'approval:p3', kind: 'approval', paneId: 'p3' },
  ];
  const ctx = { nameOf: (id: string) => (id === 'p1' ? 'Claude' : 'Codex'), agentIdOf: (id: string) => `agent-${id}` };

  it('an error and a stuck agent become rows; an approval is not a problem', () => {
    const rows = problemsFromNeeds(items, ctx);
    expect(rows.map((r) => r.id)).toEqual(['error:p1', 'stuck:p2']);
    expect(rows[0].what).toBe('Claude stopped because of an error.');
    expect(rows[1].what).toBe('Codex looks stuck.');
    expect(rows[0]).toMatchObject({ way: 'open_chat', paneId: 'p1', at: 5 });
  });

  it('a row that is no longer reported is marked fixed, and only rows of its own feed', () => {
    syncProblems('error:', problemsFromNeeds(items, ctx).filter((r) => r.id.startsWith('error:')));
    reportProblem({ ...base, id: 'signin:claude:', what: 'signed out', paneId: null, way: 'sign_in' });
    syncProblems('error:', []);
    const byId = Object.fromEntries(problemsSnapshot().map((p) => [p.id, p.fixed]));
    expect(byId['error:p1']).toBe(true);
    expect(byId['signin:claude:']).toBe(false);
  });

  it('an ended sign-in becomes a Sign in row; a good one does not', () => {
    const row = (state: UsageRow['state'], account: string | null): UsageRow => ({ agent_id: 'claude', label: 'Claude', account_id: account, account_label: account ? 'Work' : null, state, reason: null, windows: [], plan: null, observed_at_ms: null, limited_until_ms: null, page: null });
    const rows = problemsFromUsage([row('expired', 'w'), row('ok', null)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'signin:claude:w', way: 'sign_in', agentId: 'claude' });
    expect(rows[0].what).toBe("Claude (Work)'s sign-in ended.");
  });
});
