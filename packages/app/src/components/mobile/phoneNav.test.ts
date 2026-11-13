import { describe, expect, it } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { AttentionItem, AttentionSnapshot } from '../../lib/attention';
import { groupByProject, needsPaneIds, pickLanding, rowState, waitingTotal } from './phoneNav';

const pane = (id: string, status = 'idle', cwd = 'C:/work/app'): PaneInfo =>
  ({ id, agent_type: 'claude', status, created_at: 1, cwd, pid: 1, last_output_at: null, cols: 80, rows: 24 }) as unknown as PaneInfo;

const item = (paneId: string, since: number | null, risk: 'low' | 'medium' | 'high' | null = null): AttentionItem => ({
  id: `i-${paneId}`,
  key: `approval:${paneId}`,
  kind: 'approval',
  lane: 'blocking',
  rank: 1,
  state: 'open',
  since_ms: since,
  expires_at_ms: null,
  pane: { id: paneId, heading: paneId, agent: null, project: null },
  title: 't',
  sentence: null,
  risk: risk ? { level: risk, word: risk, headline: null } : null,
  prompt: null,
  actions: [],
  resolution: null,
});
const snap = (items: AttentionItem[]): AttentionSnapshot => ({ v: 1, rev: 1, counts: { blocking: items.length, ready: 0 }, items });

describe('needsPaneIds and rowState', () => {
  it('counts a prompt, a failure and an open card on the PC list', () => {
    const panes = [pane('a', 'waiting_input'), pane('b', 'error'), pane('c'), pane('d')];
    expect([...needsPaneIds(panes, snap([item('d', 5)]))].sort()).toEqual(['a', 'b', 'd']);
  });

  it('picks one of five states', () => {
    const attention = snap([item('r', 5, 'high')]);
    const panes = [pane('n', 'waiting_input'), pane('w', 'running'), pane('r', 'waiting_input'), pane('e', 'error'), pane('i')];
    const needs = needsPaneIds(panes, attention);
    expect(panes.map((p) => rowState(p, needs, attention))).toEqual(['needs', 'working', 'risk', 'broken', 'idle']);
  });
});

describe('pickLanding', () => {
  const panes = [pane('a'), pane('b'), pane('c')];

  it('is null with no chat at all, and ignores a companion pane', () => {
    expect(pickLanding([], null, null)).toBeNull();
    expect(pickLanding([pane('companion-x')], null, null)).toBeNull();
  });

  it('opens the chat that needs you, before the one read last', () => {
    expect(pickLanding([pane('a'), pane('b', 'waiting_input'), pane('c')], null, 'a')).toBe('b');
  });

  it('a chat that waits for an answer comes before one that only failed', () => {
    expect(pickLanding([pane('a', 'error'), pane('b', 'waiting_input')], null, null)).toBe('b');
    expect(pickLanding([pane('a', 'error'), pane('b')], null, 'b')).toBe('a');
  });

  it('opens the longest waiting of several', () => {
    expect(pickLanding(panes, snap([item('a', 3000), item('c', 1000)]), 'b')).toBe('c');
  });

  it('with nothing waiting opens the one read last, else the first', () => {
    expect(pickLanding(panes, null, 'c')).toBe('c');
    expect(pickLanding(panes, null, 'gone')).toBe('a');
    expect(pickLanding(panes, null, null)).toBe('a');
  });
});

describe('groupByProject', () => {
  it('groups by folder in order of first appearance and leaves out chats that need you', () => {
    const panes = [pane('a', 'idle', 'C:/work/billing'), pane('b', 'idle', 'C:/work/docs'), pane('c', 'idle', 'C:/work/billing/'), pane('d', 'idle', 'C:/work/docs')];
    const groups = groupByProject(panes, new Set(['d']));
    expect(groups.map((g) => [g.project, g.panes.map((p) => p.id)])).toEqual([
      ['billing', ['a', 'c']],
      ['docs', ['b']],
    ]);
  });
});

describe('waitingTotal', () => {
  it('is the PC number when there is one, else the chats that wait', () => {
    const panes = [pane('a', 'waiting_input'), pane('b')];
    expect(waitingTotal(panes, snap([item('a', 1), item('b', 2)]))).toBe(2);
    expect(waitingTotal(panes, null)).toBe(1);
  });
});
