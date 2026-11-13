import { describe, expect, it } from 'vitest';
import { readSeen, sinceReport, writeSeen } from './chatSince';
import { groupTurns, type ChatItem } from './sessionChatModel';

const at = (min: number) => new Date(Date.UTC(2026, 10, 13, 1, min, 0)).toISOString();
const minute = (min: number) => Date.parse(at(min));

const items: ChatItem[] = [
  { kind: 'user', id: 'u1', at: at(0), text: 'one' },
  { kind: 'assistant', id: 'a1', at: at(1), text: 'done one', model: null, finalAnswer: true },
  { kind: 'turnEnd', id: 'e1', at: at(2), outcome: 'completed', durationMs: 1000 },
  { kind: 'user', id: 'u2', at: at(10), text: 'two' },
  { kind: 'toolCall', id: 'c2', at: at(11), callId: 'k2', name: 'Edit', summary: 'a.ts', paths: ['a.ts', 'b.ts'], writes: true },
  { kind: 'toolCall', id: 'c3', at: at(12), callId: 'k3', name: 'Edit', summary: 'a.ts', paths: ['a.ts'], writes: true },
  { kind: 'turnEnd', id: 'e2', at: at(13), outcome: 'completed', durationMs: 1000 },
  { kind: 'user', id: 'u3', at: at(20), text: 'three' },
  { kind: 'assistant', id: 'a3', at: at(21), text: 'done three', model: null, finalAnswer: true },
  { kind: 'turnEnd', id: 'e3', at: at(22), outcome: 'completed', durationMs: 1000 },
];

describe('sinceReport', () => {
  const turns = groupTurns(items).turns;
  it('counts the answers and files after the last look, and points at the first turn with something new', () => {
    expect(sinceReport(turns, minute(5))).toEqual({ firstTurnId: 'u2', answers: 2, files: 2 });
  });
  it('is null when nothing is newer', () => {
    expect(sinceReport(turns, minute(30))).toBeNull();
  });
  it('treats an item with no time as old', () => {
    const noTimes = groupTurns([{ kind: 'user', id: 'x', at: null, text: 'hi' }]).turns;
    expect(sinceReport(noTimes, 1)).toBeNull();
  });
});

describe('seen moment', () => {
  it('is written and read per chat, and a broken storage is quiet', () => {
    const store = new Map<string, string>();
    const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    writeSeen('p1', 1234, fake);
    expect(readSeen('p1', fake)).toBe(1234);
    expect(readSeen('p2', fake)).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error('off');
      },
      setItem: () => {
        throw new Error('off');
      },
    };
    expect(() => writeSeen('p1', 1, broken)).not.toThrow();
    expect(readSeen('p1', broken)).toBeNull();
  });
});
