// The board's rules, without React: which column a pane is in, what its tile shows, when a quick answer is offered.
import { describe, expect, it } from 'vitest';
import type { PanePrompt } from '../../../lib/cockpit-api';
import type { NeedsYouItem } from '../../../lib/attention';
import { buildBoard, columnFor, elapsedParts, quickChoicesFor, type BoardInput } from './boardModel';

const prompt = (level: string | undefined, choices: { id: string; label: string }[]): PanePrompt =>
  ({ promptId: 'p1', kind: 'permission', text: 'Run it?', choices, risk: level ? { level } : undefined }) as unknown as PanePrompt;
const YES_NO = [
  { id: 'yes', label: 'Yes' },
  { id: 'no', label: 'No' },
];
const pane = (id: string, status: string, agent = 'claude', cwd = 'C:\\work\\shop') => ({ info: { id, agent_type: agent, cwd }, status });

function input(over: Partial<BoardInput> = {}): BoardInput {
  return {
    panes: [],
    names: new Map(),
    prompts: {},
    statusSince: new Map(),
    needsYou: [],
    activity: {},
    projectOf: (cwd) => cwd.split('\\').pop() ?? cwd,
    ...over,
  };
}

describe('columnFor', () => {
  it('puts a waiting or errored pane in Needs you, a running one in Working, the rest in Done', () => {
    expect(columnFor('waiting_input', false)).toBe('needs');
    expect(columnFor('error', false)).toBe('needs');
    expect(columnFor('running', false)).toBe('working');
    expect(columnFor('idle', false)).toBe('done');
  });

  it('a pane the attention list blocks is in Needs you even while it runs', () => {
    expect(columnFor('running', true)).toBe('needs');
  });
});

describe('buildBoard', () => {
  it('sorts panes into the three columns and keeps their order', () => {
    const board = buildBoard(input({ panes: [pane('a', 'running'), pane('b', 'idle'), pane('c', 'waiting_input'), pane('d', 'running')] }));
    expect(board.needs.map((t) => t.paneId)).toEqual(['c']);
    expect(board.working.map((t) => t.paneId)).toEqual(['a', 'd']);
    expect(board.done.map((t) => t.paneId)).toEqual(['b']);
  });

  it('uses the attention list for a blocked pane (a question for the person)', () => {
    const needsYou: NeedsYouItem[] = [{ id: 'question:q1', kind: 'question', paneId: 'a' }];
    const board = buildBoard(input({ panes: [pane('a', 'running')], needsYou }));
    expect(board.needs.map((t) => t.paneId)).toEqual(['a']);
  });

  it('leaves out companion panes', () => {
    const board = buildBoard(input({ panes: [pane('companion-xyz', 'running'), pane('a', 'running')] }));
    expect(board.working.map((t) => t.paneId)).toEqual(['a']);
  });

  it('fills name, project, live line and time in state for a tile', () => {
    const board = buildBoard(
      input({
        panes: [pane('a', 'running', 'codex', 'C:\\work\\shop')],
        names: new Map([['a', 'Codex 1']]),
        statusSince: new Map([['a', 1000]]),
        activity: { a: { kind: 'working', text: 'Running npm test' } },
      }),
    );
    expect(board.working[0]).toMatchObject({ name: 'Codex 1', agentType: 'codex', project: 'shop', activity: 'Running npm test', since: 1000 });
  });

  it('hides a live line that belongs to another status', () => {
    const board = buildBoard(input({ panes: [pane('a', 'idle')], activity: { a: { kind: 'working', text: 'Running npm test' } } }));
    expect(board.done[0].activity).toBeNull();
  });
});

describe('quickChoicesFor', () => {
  it('offers the two choices of a low-risk yes/no approval that waits', () => {
    expect(quickChoicesFor('waiting_input', prompt('low', YES_NO))).toEqual(YES_NO);
  });

  it('offers nothing for a medium or high risk prompt', () => {
    expect(quickChoicesFor('waiting_input', prompt('medium', YES_NO))).toEqual([]);
    expect(quickChoicesFor('waiting_input', prompt('high', YES_NO))).toEqual([]);
  });

  it('offers nothing for a low-risk prompt with three choices, an unrated prompt, or a pane not waiting', () => {
    const three = [...YES_NO, { id: 'always', label: 'Always' }];
    expect(quickChoicesFor('waiting_input', prompt('low', three))).toEqual([]);
    expect(quickChoicesFor('waiting_input', prompt(undefined, YES_NO))).toEqual([]);
    expect(quickChoicesFor('running', prompt('low', YES_NO))).toEqual([]);
    expect(quickChoicesFor('waiting_input', null)).toEqual([]);
  });
});

describe('elapsedParts', () => {
  it('reads under a minute as now, then minutes, then hours', () => {
    expect(elapsedParts(12_000)).toEqual({ unit: 'now', count: 0 });
    expect(elapsedParts(3 * 60_000 + 5_000)).toEqual({ unit: 'minutes', count: 3 });
    expect(elapsedParts(2 * 3_600_000)).toEqual({ unit: 'hours', count: 2 });
  });

  it('treats a negative or unknown time as now', () => {
    expect(elapsedParts(-5)).toEqual({ unit: 'now', count: 0 });
    expect(elapsedParts(Number.NaN)).toEqual({ unit: 'now', count: 0 });
  });
});
