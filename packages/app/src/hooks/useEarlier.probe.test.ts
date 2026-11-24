// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EARLIER_PROBE_MS, forgetKnownMore, useEarlier } from './useEarlier';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function renderHook<T>(use: () => T): { result: { current: T }; unmount: () => void } {
  const result = { current: undefined as T };
  const el = document.createElement('div');
  const root = createRoot(el);
  function P() {
    result.current = use();
    return null;
  }
  act(() => root.render(createElement(P)));
  return { result, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  vi.useRealTimers();
  forgetKnownMore();
});
const items = [{ kind: 'user', id: 'm1', text: 'hi' }] as never;

describe('useEarlier probe', () => {
  it('asks only after the chat stayed open, not at all for a quick switch, and once per chat', async () => {
    vi.useFakeTimers();
    const fetchPage = vi.fn(async () => ({ items: [], more: true }) as never);
    const opts = { key: 'a', ready: true, supported: true, items, setItems: () => undefined, fetchPage };
    const quick = renderHook(() => useEarlier(opts));
    await act(async () => void vi.advanceTimersByTime(EARLIER_PROBE_MS - 100));
    quick.unmount();
    expect(fetchPage).not.toHaveBeenCalled();
    const stay = renderHook(() => useEarlier(opts));
    await act(async () => void vi.advanceTimersByTime(EARLIER_PROBE_MS + 10));
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(stay.result.current.more).toBe(true);
    stay.unmount();
    const again = renderHook(() => useEarlier(opts));
    await act(async () => void vi.advanceTimersByTime(EARLIER_PROBE_MS + 10));
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(again.result.current.more).toBe(true);
  });
});
