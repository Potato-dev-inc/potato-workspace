import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTINUE_TEXT } from './acpChat';
import { offerCarryOn } from './stop-undo';
import { currentUndo, resetUndoBar, runUndo } from './undo-bar';

afterEach(() => resetUndoBar());

const stopped = (id: string) => ({ pane_id: id, agent_type: 'claude', cwd: '/p' });

describe('Stop all, undo', () => {
  it('says how many were stopped; Undo asks each of them to carry on', async () => {
    const send = vi.fn(async () => undefined);
    offerCarryOn({ stopped: [stopped('a'), stopped('b')], failed: [] }, send);
    expect(currentUndo()?.text).toBe('Stopped 2 agents');
    runUndo();
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith('a', CONTINUE_TEXT);
    expect(send).toHaveBeenCalledWith('b', CONTINUE_TEXT);
  });

  it('one agent reads in the singular', () => {
    offerCarryOn({ stopped: [stopped('a')], failed: [] }, vi.fn());
    expect(currentUndo()?.text).toBe('Stopped 1 agent');
  });

  it('shows no bar when nothing was stopped', () => {
    offerCarryOn({ stopped: [], failed: [] }, vi.fn());
    expect(currentUndo()).toBeNull();
  });
});
