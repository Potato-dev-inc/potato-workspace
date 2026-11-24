import { describe, expect, it, vi } from 'vitest';
import { waitForTurnEnd, type HandoffDeps } from './handoff';
import { steadyUsage } from './contextWindow';
import { isHandoffPrompt } from './handoffPrompt';
import { clearReverted, isPutBack, markReverted, resetReviewMarks } from './turn-review';
import { insideProject } from '../components/cockpit/rail/railFormat';
import { oneEndPerTurn } from '../components/cockpit/history-model';
import type { UsageItem } from './sessionChatModel';

const usage = (contextWindow: number): UsageItem => ({ kind: 'usage', id: 'u', at: null, inputTokens: 30_000, outputTokens: 7_000, contextWindow });

describe('files outside the project', () => {
  it('are not the project\'s changes or outputs', () => {
    const cwd = String.raw`D:\potato-workspace\tmp\gp1`;
    expect(insideProject(cwd, '/C:/Users/someone/.gemini/antigravity-cli/brain/x/plan.md')).toBe(false);
    expect(insideProject(cwd, 'D:/potato-workspace/tmp/gp1/a.txt')).toBe(true);
    expect(insideProject(cwd, '/d:/Potato-Workspace/tmp/gp1/sub/b.txt')).toBe(true);
    expect(insideProject(cwd, 'D:/potato-workspace/tmp/gp1-other/b.txt')).toBe(false);
    expect(insideProject(cwd, 'src/app.ts')).toBe(true);
    expect(insideProject('', '/anywhere/x.md')).toBe(true);
  });
});

describe('after Undo last turn', () => {
  it('the undone files are not outputs or changes, and come back when the undo is undone', () => {
    resetReviewMarks();
    markReverted('p1', ['b.txt']);
    expect(isPutBack('p1', '/D:/proj/b.txt')).toBe(true);
    expect(isPutBack('p1', 'a.txt')).toBe(false);
    // The agent writes it again in a later turn: listed again.
    expect(isPutBack('p1', 'b.txt', new Date(Date.now() + 60_000).toISOString())).toBe(false);
    expect(isPutBack('p1', 'b.txt', new Date(Date.now() - 60_000).toISOString())).toBe(true);
    clearReverted('p1', ['b.txt']);
    expect(isPutBack('p1', 'b.txt')).toBe(false);
  });
});

describe('History rows', () => {
  it('shows one end row per turn, carrying what the earlier ones counted', () => {
    const rows = oneEndPerTurn([
      { turn: 1, kind: 'after', files: 1, added: 1, deleted: 0 },
      { turn: 1, kind: 'after', files: 1, added: 1, deleted: 0 },
      { turn: 1, kind: 'before', files: 2, added: 2, deleted: 0 },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['after', 'before']);
    expect(rows[0]).toMatchObject({ files: 2, added: 2 });
  });
});

describe('context meter', () => {
  it('keeps the bigger window the agent reported for the same model', () => {
    expect(steadyUsage('c1', 'm', usage(200_000))?.contextWindow).toBe(200_000);
    expect(steadyUsage('c1', 'm', usage(1_000_000))?.contextWindow).toBe(1_000_000);
    expect(steadyUsage('c1', 'm', usage(200_000))?.contextWindow).toBe(1_000_000);
    expect(steadyUsage('c1', 'other', usage(200_000))?.contextWindow).toBe(200_000);
  });
});

describe('Hand off', () => {
  it('knows its own long message', () => {
    expect(isHandoffPrompt('Please write a handoff for the next agent to this exact file: x')).toBe(true);
    expect(isHandoffPrompt('please fix the bug')).toBe(false);
  });

  it('keeps waiting while the agent asks the person, and ends when the turn does (no "stopped to ask" failure)', async () => {
    const states = ['busy', 'waiting_input', 'waiting_input', 'running', 'idle'];
    let i = 0;
    let clock = 0;
    const deps: Pick<HandoffDeps, 'pane' | 'chatState' | 'sleep' | 'now'> = {
      pane: () => ({ id: 'p', agentType: 'a', cwd: 'C:/x', lane: 'acp', status: 'idle' }),
      chatState: async () => {
        const s = states[Math.min(i++, states.length - 1)];
        return { closed: false, status: s === 'waiting_input' ? 'waiting_input' : 'idle', turnInFlight: s === 'busy' || s === 'running', permissions: [] } as never;
      },
      sleep: async (ms) => void (clock += ms),
      now: () => clock,
    };
    const asked = vi.fn();
    expect(await waitForTurnEnd('p', deps, asked)).toBe('done');
    expect(asked.mock.calls).toEqual([[true], [false]]);
  });
});
