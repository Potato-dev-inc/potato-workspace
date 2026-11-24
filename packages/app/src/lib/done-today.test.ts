import { describe, expect, it } from 'vitest';
import { doneToday } from './done-today';
import type { TurnSummary } from './cockpit-api';

const summary = (sentence: string, files = 0): TurnSummary =>
  ({ paneId: 'p', agent: 'codex', turn: 1, startedAtMs: 1000, endedAtMs: 2000, durationMs: 1000, files: files ? { count: files, added: 1, deleted: 0 } : null, approvals: [], end: { kind: 'idle' }, sentence }) as TurnSummary;

describe('doneToday', () => {
  it('lists an instant sign-in failure as needing setup, not as finished work', () => {
    expect(doneToday([summary('Missing environment variable: SABLE_API_KEY.')], 3000)[0]?.kind).toBe('setup');
    expect(doneToday([summary('Ran the tests.')], 3000)[0]?.kind).toBe('open');
  });
});
