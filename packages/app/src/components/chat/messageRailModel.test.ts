// The message rail's plain data: which messages get a dash, where the dashes go, and where the keys move to.
import { describe, expect, it } from 'vitest';
import { groupTurns, type ChatItem } from '../../lib/sessionChat';
import { buildRailEntries, neighbourOwn, railMatches, railSlots, RAIL_MIN_GAP, slotAt, slotOfEntry } from './messageRailModel';

const ITEMS: ChatItem[] = [
  { kind: 'user', id: 'u1', at: null, text: 'Fix the login page' },
  { kind: 'assistant', id: 'a1', at: null, text: 'Looking at it.', model: null, finalAnswer: false },
  { kind: 'toolCall', id: 'c1', at: null, callId: 'k1', name: 'Read', summary: 'login.ts', paths: ['login.ts'] },
  { kind: 'toolResult', id: 'r1', at: null, callId: 'k1', ok: true, output: 'x' },
  { kind: 'assistant', id: 'a2', at: null, text: 'Fixed it.', model: null, finalAnswer: true },
  { kind: 'turnEnd', id: 'e1', at: null, outcome: 'completed', durationMs: 1000 },
  { kind: 'user', id: 'u2', at: null, text: 'Thanks' },
];

describe('buildRailEntries', () => {
  const { turns } = groupTurns(ITEMS);

  it('has one entry per message: the person and each reply of the agent, not tool rows', () => {
    expect(buildRailEntries(turns, 'normal').map((e) => [e.id, e.who])).toEqual([
      ['u1', 'you'],
      ['a1', 'agent'],
      ['a2', 'agent'],
      ['u2', 'you'],
    ]);
  });

  it('Summary lists only the final answers, as the chat shows only those', () => {
    expect(buildRailEntries(turns, 'summary').map((e) => e.id)).toEqual(['u1', 'a2', 'u2']);
  });
});

describe('railSlots', () => {
  it('spaces few messages evenly, centred, at the widest gap', () => {
    const slots = railSlots(5, 300);
    expect(slots).toHaveLength(5);
    expect(slots.map((s) => s.index)).toEqual([0, 1, 2, 3, 4]);
    expect(slots[1].top - slots[0].top).toBe(7);
    expect(slots[0].top + slots[4].top).toBeCloseTo(300, 5);
  });

  it('shrinks the gap for more messages but never below the narrowest', () => {
    const slots = railSlots(60, 240);
    expect(slots).toHaveLength(60);
    const gap = slots[1].top - slots[0].top;
    expect(gap).toBeLessThan(7);
    expect(gap).toBeGreaterThanOrEqual(RAIL_MIN_GAP);
  });

  it('samples an enormous chat evenly and stays inside the rail', () => {
    const slots = railSlots(5000, 240);
    expect(slots.length).toBeLessThan(5000);
    expect(slots[0].top).toBeGreaterThanOrEqual(0);
    expect(slots[slots.length - 1].top).toBeLessThanOrEqual(240);
    // Every message belongs to exactly one dash, in order.
    expect(slots[0].from).toBe(0);
    expect(slots[slots.length - 1].to).toBe(4999);
    for (let i = 1; i < slots.length; i++) expect(slots[i].from).toBe(slots[i - 1].to + 1);
    expect(slotOfEntry(slots, 2500)).toBeGreaterThan(0);
  });

  it('finds the nearest dash for a height', () => {
    const slots = railSlots(5, 300);
    expect(slotAt(slots, slots[3].top + 1)).toBe(3);
    expect(slotAt(slots, -50)).toBe(0);
    expect(slotAt(slots, 9999)).toBe(4);
  });
});

describe('neighbourOwn and railMatches', () => {
  const entries = buildRailEntries(groupTurns(ITEMS).turns, 'normal');

  it('moves to the own previous and next message of the person, or nowhere at the ends', () => {
    expect(neighbourOwn(entries, 2, -1)).toBe(0);
    expect(neighbourOwn(entries, 2, 1)).toBe(3);
    expect(neighbourOwn(entries, 0, -1)).toBeNull();
    expect(neighbourOwn(entries, 3, 1)).toBeNull();
  });

  it('matches by text without caring about case; an empty query matches nothing', () => {
    expect([...railMatches(entries, 'FIX')]).toEqual([0, 2]);
    expect(railMatches(entries, '  ').size).toBe(0);
  });
});
