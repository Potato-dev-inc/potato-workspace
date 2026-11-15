import { describe, expect, it } from 'vitest';
import type { StandbyHelperEntry } from '../../lib/standbyHelpers';
import { placeHelpers, rowState } from './standby-rows';

const pane = (id: string, cwd = 'C:/work/app', parent: string | null = null, seat: string | null = null) => ({ info: { id, cwd, parent_pane_id: parent, standby_seat: seat }, status: 'idle' });
const helper = (over: Partial<StandbyHelperEntry>): StandbyHelperEntry => ({
  id: 'sb-1', name: 'Reviewer', agent: 'codex', model: null, project: 'C:/work/app', after_task: 'wait', state: 'ready', note: null,
  pane_id: null, home: 'a1', used_by: null, taken_over: false, open_pane: null, person_pane: null, ...over,
});

describe('placeHelpers', () => {
  const panes = [pane('a1'), pane('a2')];
  it('a waiting helper sits under its home agent', () => {
    const p = placeHelpers([helper({})], panes);
    expect(p.byAgent.get('a1')?.map((r) => r.helper.id)).toEqual(['sb-1']);
  });
  it('every waiting state stays under home', () => {
    for (const state of ['starting', 'asleep', 'problem'] as const) {
      expect(placeHelpers([helper({ state })], panes).byAgent.get('a1')).toHaveLength(1);
    }
  });
  it('working for an agent: the seat keeps its one row under its home, and the task chat is that row, never an agent', () => {
    const live = [pane('a1'), pane('chat-7', 'C:/work/app', 'a1', 'sb-1'), pane('a2')];
    const p = placeHelpers([helper({ state: 'busy', used_by: 'agent', pane_id: 'chat-7' })], live);
    expect([...p.byAgent.keys()]).toEqual(['a1']);
    expect(p.byAgent.get('a1')).toHaveLength(1);
    expect(p.byAgent.get('a1')?.[0]).toMatchObject({ state: 'working', paneId: 'chat-7', under: 'a1' });
    expect(p.hiddenPanes.has('chat-7')).toBe(true);
    expect(p.loose.size).toBe(0);
  });
  it('the task chat is hidden from the first moment it is listed, before the helper list says busy', () => {
    // The pane list says the chat is seat sb-1's own; the helper list is a moment behind (still "ready", no pane).
    const early = [pane('a1'), pane('chat-7', 'C:/work/app', null, 'sb-1')];
    const p = placeHelpers([helper({})], early);
    expect(p.hiddenPanes.has('chat-7')).toBe(true);
    expect(p.byAgent.get('a1')?.[0]).toMatchObject({ under: 'a1', paneId: 'chat-7' });
    // Nested under the agent that asked: it is a task, so the row already says Working.
    const linked = [pane('a1'), { ...pane('chat-7', 'C:/work/app', 'a1', 'sb-1'), status: 'running' }];
    expect(placeHelpers([helper({})], linked).byAgent.get('a1')?.[0].state).toBe('working');
    // The same chat, finished and not dropped from the list yet, with a helper list that is ahead: the row is Ready, not Working.
    const stale = [pane('a1'), pane('chat-7', 'C:/work/app', 'a1', 'sb-1')];
    expect(placeHelpers([helper({ state: 'ready', past_panes: [] })], stale).byAgent.get('a1')?.[0].state).toBe('ready');
  });
  it('a finished task chat that is still open is the seat own chat, never an agent, and the row is Ready and opens a clean chat', () => {
    const live = [pane('a1'), pane('chat-7', 'C:/work/app', 'a1', 'sb-1')];
    const p = placeHelpers([helper({ state: 'ready', past_panes: ['chat-7'] })], live);
    expect(p.hiddenPanes.has('chat-7')).toBe(true);
    expect(p.byAgent.get('a1')?.[0]).toMatchObject({ state: 'ready', paneId: null, under: 'a1' });
  });
  it('a chat of a seat the person removed is an ordinary chat again', () => {
    const live = [pane('a1'), pane('chat-7', 'C:/work/app', 'a1', 'gone-seat')];
    expect(placeHelpers([helper({})], live).hiddenPanes.has('chat-7')).toBe(false);
  });
  it('the seat never becomes the home of another seat and is never a main agent', () => {
    const live = [pane('a1'), pane('chat-7', 'C:/work/app', null, 'sb-1')];
    const p = placeHelpers([helper({}), helper({ id: 'sb-2', home: 'gone' })], live);
    expect(p.byAgent.get('a1')?.map((r) => r.helper.id).sort()).toEqual(['sb-1', 'sb-2']);
    expect(p.byAgent.has('chat-7')).toBe(false);
  });
  it('working for an agent whose chat is not listed yet still shows, under home', () => {
    const p = placeHelpers([helper({ state: 'busy', used_by: 'agent', pane_id: 'chat-9' })], panes);
    expect(p.byAgent.get('a1')?.[0].state).toBe('working');
  });
  it('with the person: stays under home, their open chat is hidden as an agent', () => {
    const live = [pane('a1'), pane('chat-3')];
    const p = placeHelpers([helper({ state: 'busy', used_by: 'person', open_pane: 'chat-3' })], live);
    expect(p.byAgent.get('a1')?.[0]).toMatchObject({ state: 'withYou', paneId: 'chat-3' });
    expect(p.hiddenPanes.has('chat-3')).toBe(true);
  });
  it('a ready helper the person opened shows its chat as the row', () => {
    const live = [pane('a1'), pane('chat-3')];
    const p = placeHelpers([helper({ open_pane: 'chat-3' })], live);
    expect(p.byAgent.get('a1')?.[0].paneId).toBe('chat-3');
  });
  it('home agent closed: the newest main agent of the project takes it', () => {
    const p = placeHelpers([helper({ home: 'gone' })], [pane('a1'), pane('a2'), pane('x', 'C:/other')]);
    expect(p.byAgent.get('a2')).toHaveLength(1);
  });
  it('no home at all: the same rule', () => {
    expect(placeHelpers([helper({ home: null })], panes).byAgent.get('a2')).toHaveLength(1);
  });
  it('no main agent in the project: the loose group', () => {
    const p = placeHelpers([helper({ home: 'gone' })], [pane('x', 'C:/other')]);
    expect(p.byAgent.size).toBe(0);
    expect(p.loose.get('c:/work/app')).toHaveLength(1);
  });
  it('a helper pane is never the new home', () => {
    const p = placeHelpers([helper({ home: 'gone' })], [pane('a1'), pane('h', 'C:/work/app', 'a1')]);
    expect(p.byAgent.get('a1')).toHaveLength(1);
  });
  it('working rows come first', () => {
    const rows = placeHelpers([helper({ id: 'r' }), helper({ id: 'w', state: 'busy', used_by: 'agent', pane_id: 'x' })], panes).byAgent.get('a1')!;
    expect(rows.map((r) => r.helper.id)).toEqual(['w', 'r']);
  });
  it('rowState words', () => {
    expect(rowState(helper({ state: 'asleep' }))).toBe('resting');
    expect(rowState(helper({ state: 'busy', used_by: 'person' }))).toBe('withYou');
  });
  it('a chat that appeared while the helper was opening is hidden, and the row keeps its home (never the newest agent)', () => {
    const live = [pane('a1'), pane('a2'), pane('chat-9')];
    const p = placeHelpers([helper({ home: 'a1' })], live, new Set(['chat-9']));
    expect(p.hiddenPanes.has('chat-9')).toBe(true);
    expect(p.byAgent.get('a1')?.map((r) => r.helper.id)).toEqual(['sb-1']);
  });
});
