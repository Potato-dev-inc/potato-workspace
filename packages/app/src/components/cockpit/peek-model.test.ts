import { describe, expect, it } from 'vitest';
import type { PanePrompt, TurnSummary } from '../../lib/cockpit-api';
import { PEEK_DELAY_MS } from './peek-model';
import { peekModel, type PeekInput } from './peek-model';
import { peekPosition } from './usePeek';

const turn = (over: Partial<TurnSummary> = {}): TurnSummary => ({
  paneId: 'p',
  agent: 'claude',
  turn: 3,
  startedAtMs: 0,
  endedAtMs: 1,
  durationMs: 1,
  files: { count: 4, added: 10, deleted: 2, paths: ['a', 'b', 'c', 'd'] },
  approvals: [],
  end: { kind: 'idle' },
  sentence: 'Changed 4 files and the tests pass.',
  ...over,
});

const base: PeekInput = { status: 'idle', activity: undefined, since: undefined, now: 600_000, lastTurn: undefined, usage: null, prompt: null };

describe('peekModel', () => {
  it('opens after 400 ms', () => {
    expect(PEEK_DELAY_MS).toBe(400);
  });

  it('a running agent: its step, how long it has run, and what the last turn did', () => {
    const m = peekModel({
      ...base,
      status: 'running',
      activity: { kind: 'working', text: 'Editing cart.tsx' } as PeekInput['activity'],
      since: 600_000 - 125_000,
      lastTurn: turn(),
      usage: { own: { turns: 3, busyMs: 180_000 }, helperCount: 0, helperTurns: 0, helperBusyMs: 0, helpers: [] },
    });
    expect(m.step).toBe('Editing cart.tsx');
    expect(m.running).toBe('2m');
    expect(m.files).toBe(4);
    expect(m.usage).toEqual({ turns: 3, time: '3m' });
    expect(m.lastLine).toBe('Changed 4 files and the tests pass.');
    expect(m.empty).toBe(false);
  });

  it('an idle agent with nothing known is empty, and shows no running time', () => {
    const m = peekModel({ ...base, since: 1 });
    expect(m.running).toBeNull();
    expect(m.empty).toBe(true);
  });

  it('usage with no turns says nothing, never a zero', () => {
    expect(peekModel({ ...base, usage: { own: { turns: 0, busyMs: 0 }, helperCount: 0, helperTurns: 0, helperBusyMs: 0, helpers: [] } }).usage).toBeNull();
  });

  it('a turn with unknown files says nothing about files', () => {
    expect(peekModel({ ...base, lastTurn: turn({ files: null }) }).files).toBeNull();
  });

  it('a low-risk yes/no question can be answered here; any other question only opens the chat', () => {
    const yesNo: PanePrompt = {
      promptId: 'q1',
      kind: 'approval',
      text: 'Run npm test?',
      choices: [
        { id: 'y', label: 'Yes' },
        { id: 'n', label: 'No' },
      ],
      risk: { level: 'low', headline: 'Safe', reasons: [] },
    };
    const m = peekModel({ ...base, status: 'waiting_input', prompt: yesNo });
    expect(m.question?.quick.map((c) => c.label)).toEqual(['Yes', 'No']);
    const risky = peekModel({ ...base, status: 'waiting_input', prompt: { ...yesNo, risk: { level: 'high', headline: 'Deletes files', reasons: [] } } });
    expect(risky.question?.text).toBe('Run npm test?');
    expect(risky.question?.quick).toEqual([]);
  });

  it('a question is shown only while the agent waits', () => {
    const prompt: PanePrompt = { promptId: 'q', kind: 'x', text: 'Sure?', choices: [{ id: 'y', label: 'Yes' }] };
    expect(peekModel({ ...base, status: 'idle', prompt }).question).toBeNull();
  });
});

describe('peekPosition', () => {
  it('sits to the right of the row, level with it', () => {
    expect(peekPosition({ left: 0, right: 260, top: 100 }, { width: 1280, height: 800 })).toEqual({ left: 268, top: 94 });
  });
  it('goes to the left when there is no room on the right, and stays inside the window at the bottom', () => {
    const p = peekPosition({ left: 900, right: 1160, top: 790 }, { width: 1200, height: 800 });
    expect(p.left).toBeLessThan(900);
    expect(p.top).toBeLessThanOrEqual(800 - 260 - 8);
  });
});
