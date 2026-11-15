import { describe, expect, it } from 'vitest';
import type { StandbyHelperEntry } from '../../lib/standbyHelpers';
import { placeHelpers, rowState } from './standby-rows';

const pane = (id: string, cwd = 'C:/work/app', parent: string | null = null) => ({ info: { id, cwd, parent_pane_id: parent }, status: 'idle' });
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
  it('working for an agent: the task chat is already a helper row, so no second row', () => {
    const live = [pane('a1'), pane('chat-7', 'C:/work/app', 'a2'), pane('a2')];
    const p = placeHelpers([helper({ state: 'busy', used_by: 'agent', pane_id: 'chat-7' })], live);
    expect(p.byAgent.size).toBe(0);
    expect(p.loose.size).toBe(0);
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
