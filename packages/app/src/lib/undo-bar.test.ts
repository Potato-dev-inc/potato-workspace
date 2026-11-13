import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentUndo, finishUndo, holdUndo, resetUndoBar, runUndo, showUndo, UNDO_BAR_MS } from './undo-bar';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  resetUndoBar();
  vi.useRealTimers();
});

describe('the undo bar store', () => {
  it('shows for 8 seconds and then runs commit once', async () => {
    const commit = vi.fn();
    showUndo({ text: 'Closed A', undo: vi.fn(), commit });
    expect(currentUndo()?.text).toBe('Closed A');
    await vi.advanceTimersByTimeAsync(UNDO_BAR_MS - 10);
    expect(currentUndo()).not.toBeNull();
    expect(commit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(currentUndo()).toBeNull();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('Undo runs undo, never commit, and clears the bar', async () => {
    const undo = vi.fn();
    const commit = vi.fn();
    showUndo({ text: 'x', undo, commit });
    expect(runUndo()).toBe(true);
    await vi.advanceTimersByTimeAsync(UNDO_BAR_MS * 2);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(currentUndo()).toBeNull();
    expect(runUndo()).toBe(false);
  });

  it('a new bar replaces the old one and the old one is then final', async () => {
    const first = vi.fn();
    showUndo({ text: 'one', undo: vi.fn(), commit: first });
    showUndo({ text: 'two', undo: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledTimes(1);
    expect(currentUndo()?.text).toBe('two');
  });

  it('a bar without undo has no Undo and runUndo does nothing', () => {
    showUndo({ text: 'Could not do that' });
    expect(currentUndo()?.undo).toBeUndefined();
    expect(runUndo()).toBe(false);
  });

  it('holding stops the clock and letting go starts it again', async () => {
    const commit = vi.fn();
    showUndo({ text: 'x', undo: vi.fn(), commit });
    await vi.advanceTimersByTimeAsync(5000);
    holdUndo(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(currentUndo()).not.toBeNull();
    holdUndo(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(currentUndo()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(currentUndo()).toBeNull();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('finishUndo ends the bar at once and commits', async () => {
    const commit = vi.fn();
    const id = showUndo({ text: 'x', undo: vi.fn(), commit });
    finishUndo(id);
    await vi.advanceTimersByTimeAsync(0);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(currentUndo()).toBeNull();
  });

  it('a failed commit shows one plain bar with no Undo', async () => {
    showUndo({ text: 'x', undo: vi.fn(), commit: () => Promise.reject(new Error('no')), failText: 'That did not work.' });
    await vi.advanceTimersByTimeAsync(UNDO_BAR_MS + 10);
    expect(currentUndo()?.text).toBe('That did not work.');
    expect(currentUndo()?.undo).toBeUndefined();
  });
});
