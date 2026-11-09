// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOLLOW_FOCUS_DEBOUNCE_MS, useFollowFocusedProject } from './useFollowFocusedProject';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ project, send }: { project: string | null; send: (p: string) => unknown }) {
  useFollowFocusedProject(project, send);
  return null;
}

describe('useFollowFocusedProject', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the folder only after it stayed focused for the debounce, and only the last one', () => {
    const send = vi.fn();
    const host = document.createElement('div');
    const root = createRoot(host);
    const render = (project: string | null) => act(() => root.render(createElement(Probe, { project, send })));
    render('/a');
    act(() => void vi.advanceTimersByTime(FOLLOW_FOCUS_DEBOUNCE_MS - 100));
    render('/b'); // clicked on through the panes
    act(() => void vi.advanceTimersByTime(FOLLOW_FOCUS_DEBOUNCE_MS - 100));
    expect(send).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(200));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('/b');
    render(null); // nothing focused says nothing
    act(() => void vi.advanceTimersByTime(FOLLOW_FOCUS_DEBOUNCE_MS * 2));
    expect(send).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});
