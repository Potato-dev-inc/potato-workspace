// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, resetGettingStarted } from '../../lib/getting-started';
import { restoreWithUndo } from './restore-flow';

// @vitest-environment jsdom
beforeEach(() => {
  localStorage.clear();
  resetGettingStarted();
});

describe('restoreWithUndo and the Getting started list', () => {
  it('a restored turn ticks "Undo a turn"', async () => {
    const api = { checkpointRestore: vi.fn(async () => ({ restored: ['a'], failed: [], safetyId: 's1' })) };
    await restoreWithUndo(api as never, 'p1', { id: 'c1', label: 'Before the cart fix' }, vi.fn());
    expect(getState().done).toContain('undo');
  });

  it('a restore that failed ticks nothing', async () => {
    const api = { checkpointRestore: vi.fn(async () => Promise.reject(new Error('no'))) };
    await restoreWithUndo(api as never, 'p1', { id: 'c1', label: 'x' }, vi.fn());
    expect(getState().done).not.toContain('undo');
  });
});
