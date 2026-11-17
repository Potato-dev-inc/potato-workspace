import { describe, expect, it } from 'vitest';
import { crewChipView, crewGroups, crewMembers, visibleRows, type CrewMember } from './crew-chip';

const pane = (id: string, status: string, o: { parent?: string; as?: string; title?: string; at?: number; standby?: string } = {}) => ({
  status,
  info: { id, agent_type: 'claude', created_at: o.at ?? 1, title: o.title ?? id, parent_pane_id: o.parent ?? null, started_as: o.as ?? null, standby_seat: o.standby ?? null },
});
const name = () => 'Claude';
const make = (specs: Array<[string, string, string?]>) =>
  crewMembers([pane('P', 'running'), ...specs.map(([id, status, as], i) => pane(id, status, { parent: 'P', as: as ?? 'spin_off', at: 10 + i }))], 'P', name);

describe('crew chip text', () => {
  it('is nothing when the chat started nothing (an unclaimed standby has no parent)', () => {
    expect(crewChipView(crewMembers([pane('P', 'running'), pane('S', 'idle', { standby: 'a' })], 'P', name))).toBeNull();
  });

  it('names the only agent it started', () => {
    const v = crewChipView(crewMembers([pane('P', 'running'), pane('s1', 'running', { parent: 'P', as: 'spin_off', title: 'OpenCode 2' })], 'P', name))!;
    expect(v.text).toBe('Spin-off: OpenCode 2 · working');
    expect(v.only?.id).toBe('s1');
    expect(v.tone).toBe('working');
  });

  it('counts by kind for 3 agents', () => {
    const v = crewChipView(make([['a', 'running'], ['b', 'idle'], ['c', 'running', 'minion']]))!;
    expect(v.text).toBe('2 spin-offs · 1 minion');
    expect(v.only).toBeNull();
  });

  it('counts by state for 12 agents, and needs-you comes first', () => {
    const specs: Array<[string, string, string?]> = [];
    for (let i = 0; i < 6; i += 1) specs.push([`d${i}`, 'idle', i % 2 ? 'minion' : 'spin_off']);
    for (let i = 0; i < 4; i += 1) specs.push([`w${i}`, 'running', 'minion']);
    specs.push(['n0', 'waiting_input'], ['n1', 'waiting_input', 'minion']);
    const members = make(specs);
    expect(members.slice(0, 2).map((m) => m.state)).toEqual(['needs-you', 'needs-you']);
    expect(members.slice(-6).every((m) => m.state === 'done')).toBe(true);
    const v = crewChipView(members)!;
    expect(v.text).toBe('2 need you · 4 working · 6 done');
    expect(v.tone).toBe('needs-you');
  });

  it('is a quiet "12 done" when all have finished', () => {
    const v = crewChipView(make(Array.from({ length: 12 }, (_, i): [string, string] => [`d${i}`, 'idle'])))!;
    expect(v.text).toBe('12 done');
    expect(v.tone).toBe('quiet');
  });

  it('a failed one is counted by state, even with few agents', () => {
    expect(crewChipView(make([['a', 'error'], ['b', 'idle']]))!.text).toBe('1 failed · 1 done');
  });
});

describe('crew panel rows', () => {
  const m = (id: string, state: CrewMember['state'], kind: CrewMember['kind'] = 'spin_off'): CrewMember => ({ id, kind, title: id, agentType: 'claude', state, startedAt: 1 });

  it('groups spin-offs before minions and leaves out an empty group', () => {
    expect(crewGroups([m('a', 'done', 'minion'), m('b', 'working')]).map((g) => g.kind)).toEqual(['spin_off', 'minion']);
    expect(crewGroups([m('a', 'done', 'minion')]).map((g) => g.kind)).toEqual(['minion']);
  });

  it('folds more than two finished rows into one line; failed rows never fold', () => {
    const group = crewGroups([m('w', 'working'), m('f', 'failed'), m('d1', 'done'), m('d2', 'done'), m('d3', 'done')])[0]!;
    const folded = visibleRows(group, false);
    expect(folded.rows.map((r) => r.id)).toEqual(['w', 'f']);
    expect(folded.folded).toBe(3);
    expect(visibleRows(group, true).rows).toHaveLength(5);
    const few = crewGroups([m('d1', 'done'), m('d2', 'done')])[0]!;
    expect(visibleRows(few, false)).toMatchObject({ folded: 0 });
  });

  it('keeps a finished minion in the list (it is marked done, never removed)', () => {
    const members = make([['m1', 'idle', 'minion']]);
    expect(members).toHaveLength(1);
    expect(members[0]!.state).toBe('done');
  });
});
