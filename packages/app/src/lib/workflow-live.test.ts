// The live view's model: which box a helper stands in, the one state per box, the log lines, and what counts as news.
import { describe, expect, it } from 'vitest';
import type { Crew } from './crews-api';
import { diffLive, eventText, liveHelpers, roleOfHelper, roleStates, seenOf, workflowStatus, type LivePane } from './workflow-live';

const crew = {
  name: 'Router',
  roles: [
    { name: 'Front', agent_type: 'claude', model: 'haiku', task: 'Route.', front: true },
    { name: 'Sonnet', agent_type: 'claude', model: 'sonnet', task: 'Hard.', parent: 'Front' },
    { name: 'Reviewer', agent_type: 'codex', model: 'gpt', task: 'Review.', parent: 'Front' },
  ],
} as unknown as Crew;

const pane = (id: string, over: Record<string, unknown> = {}, status = 'running'): LivePane =>
  ({ info: { id, agent_type: 'claude', created_at: 1000, parent_pane_id: 'front', started_as: 'minion', origin: { task: 'fix login test' }, ...over }, status }) as unknown as LivePane;
const front = pane('front', { parent_pane_id: null, started_as: null });
const name = (p: LivePane) => p.info.agent_type;

describe('which box a helper stands in', () => {
  it('matches the agent, and the box name when two boxes share an agent', () => {
    const m = { id: 'a', kind: 'minion', title: 'x', agentType: 'codex', state: 'working', startedAt: 0 } as const;
    expect(roleOfHelper(crew, m, null)?.name).toBe('Reviewer');
    expect(roleOfHelper(crew, { ...m, agentType: 'claude' }, null)?.name).toBe('Sonnet');
    expect(roleOfHelper(crew, { ...m, agentType: 'gemini' }, null)).toBeNull();
    const two = { ...crew, roles: [...crew.roles, { name: 'Quick', agent_type: 'claude', parent: 'Front' }] } as unknown as Crew;
    expect(roleOfHelper(two, { ...m, agentType: 'claude' }, 'ask Quick to look')?.name).toBe('Quick');
  });

  it('lists only the helpers of the front chat, with the box name as who', () => {
    const hs = liveHelpers(crew, [front, pane('h1'), pane('other', { parent_pane_id: 'zzz' })], 'front', name);
    expect(hs.map((h) => [h.id, h.roleKey, h.who, h.state])).toEqual([['h1', 'Sonnet', 'Sonnet', 'working']]);
  });
});

describe('one state per box', () => {
  it('shows the most pressing helper and counts the rest', () => {
    const hs = liveHelpers(crew, [front, pane('a'), pane('b', {}, 'waiting_input'), pane('c', {}, 'idle')], 'front', name);
    const s = roleStates(hs).get('Sonnet')!;
    expect(s).toMatchObject({ state: 'needs-you', helperId: 'b', count: 3 });
  });
  it('words the status line, and says nothing while all is done', () => {
    const hs = liveHelpers(crew, [front, pane('a'), pane('b'), pane('c', {}, 'waiting_input')], 'front', name);
    expect(workflowStatus(hs)).toBe('2 agents working, 1 needs you');
    expect(workflowStatus(liveHelpers(crew, [front, pane('a', {}, 'idle')], 'front', name))).toBeNull();
  });
});

describe('the log', () => {
  const at = 5000;
  it('the first look tells how helpers began, and how a finished one stands', () => {
    const hs = liveHelpers(crew, [front, pane('a', { created_at: 1000 }), pane('b', { created_at: 2000 }, 'idle')], 'front', name);
    const ev = diffLive(null, hs, at);
    expect(ev.map((e) => [e.kind, e.helperId, e.at])).toEqual([['started', 'a', 1000], ['started', 'b', 2000], ['finished', 'b', at]]);
    expect(ev[2].took).toBeUndefined();
  });
  it('a new helper is a start; a finish carries how long it took; a repeat says nothing', () => {
    const one = liveHelpers(crew, [front, pane('a', { created_at: 1000 })], 'front', name);
    const seen = seenOf(one);
    expect(diffLive(seen, one, at)).toEqual([]);
    const two = liveHelpers(crew, [front, pane('a', { created_at: 1000 }, 'idle'), pane('r', { agent_type: 'codex', created_at: 4000 })], 'front', name);
    const ev = diffLive(seen, two, at);
    expect(ev.map((e) => [e.kind, e.who])).toEqual([['started', 'Reviewer'], ['finished', 'Sonnet']]);
    expect(ev.find((e) => e.kind === 'finished')!.took).toBe(4000);
  });
  it('needs you and failed are events too', () => {
    const base = diffLive(null, liveHelpers(crew, [front, pane('a')], 'front', name), 0);
    expect(base).toHaveLength(1);
    const seen = seenOf(liveHelpers(crew, [front, pane('a')], 'front', name));
    expect(diffLive(seen, liveHelpers(crew, [front, pane('a', {}, 'waiting_input')], 'front', name), at).map((e) => e.kind)).toEqual(['needs-you']);
    expect(diffLive(seen, liveHelpers(crew, [front, pane('a', {}, 'error')], 'front', name), at).map((e) => e.kind)).toEqual(['failed']);
  });
  it('writes plain words', () => {
    const [started] = diffLive(null, liveHelpers(crew, [front, pane('a')], 'front', name), 0);
    expect(eventText(started)).toBe('Sonnet started: fix login test');
    expect(eventText({ ...started, kind: 'finished', took: 130000 })).toBe('Sonnet finished (2m)');
    expect(eventText({ ...started, kind: 'finished' })).toBe('Sonnet finished');
    expect(eventText({ ...started, kind: 'needs-you', who: 'Reviewer' })).toBe('Reviewer needs you');
    expect(eventText({ ...started, kind: 'failed' })).toBe('Sonnet failed');
  });
});

describe('which box, more carefully', () => {
  const mk = (roles: Array<Record<string, unknown>>) => ({ name: 'C', roles: [{ name: 'Front', agent_type: 'claude', front: true }, ...roles.map((r) => ({ parent: 'Front', ...r }))] }) as unknown as Crew;
  const m = (over: Record<string, unknown> = {}) => ({ id: 'a', kind: 'minion', title: 'x', agentType: 'claude', state: 'working', startedAt: 0, ...over }) as never;
  it('takes whole words only and prefers the longest box name', () => {
    const c = mk([{ name: 'Test', agent_type: 'claude' }, { name: 'Tester', agent_type: 'claude' }, { name: 'Test plan', agent_type: 'claude' }]);
    expect(roleOfHelper(c, m(), 'run the Tester now')?.name).toBe('Tester');
    expect(roleOfHelper(c, m(), 'write the test plan')?.name).toBe('Test plan');
    const r = mk([{ name: 'Review', agent_type: 'claude' }, { name: 'Other', agent_type: 'claude' }]);
    expect(roleOfHelper(r, m(), 'a reviewer is wanted', new Set(['Review']))?.name).toBe('Other'); // "reviewer" is not "Review"
  });
  it('gives an unmatched agent a free box of its type, and does not let a typeless box catch every agent', () => {
    const c = mk([{ name: 'A', agent_type: 'claude' }, { name: 'B', agent_type: 'claude' }, { name: 'Any', agent_type: '{default}' }]);
    expect(roleOfHelper(c, m(), null, new Set(['A']))?.name).toBe('B');
    expect(roleOfHelper(c, m(), null, new Set(['A', 'B']))?.name).toBe('A'); // all used: the first, never the typeless box
    const only = mk([{ name: 'Any', agent_type: '{default}' }]);
    expect(roleOfHelper(only, m(), null)?.name).toBe('Any');
  });
  it('liveHelpers spreads two untitled agents over two boxes', () => {
    const c = mk([{ name: 'A', agent_type: 'claude' }, { name: 'B', agent_type: 'claude' }]);
    const hs = liveHelpers(c, [front, pane('a', { created_at: 1 }), pane('b', { created_at: 2 })], 'front', name);
    expect(hs.map((h) => h.roleKey)).toEqual(['A', 'B']);
  });
});
