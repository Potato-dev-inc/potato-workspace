// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSettledStatus } from './useSettledStatus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(first: string) {
  let shown: string | undefined;
  const root = createRoot(document.createElement('div'));
  const Probe = ({ s }: { s: string }) => {
    shown = useSettledStatus(s);
    return null;
  };
  const set = (s: string) => act(() => root.render(<Probe s={s} />));
  set(first);
  return { set, shown: () => shown, wait: (ms: number) => act(() => void vi.advanceTimersByTime(ms)) };
}

it('holds running for 1.5 s and does not show idle in a quick flap', () => {
  const h = setup('idle');
  h.set('running');
  expect(h.shown()).toBe('running');
  h.wait(300);
  h.set('idle');
  h.wait(900);
  expect(h.shown()).toBe('running');
  h.set('running');
  h.wait(5000);
  expect(h.shown()).toBe('running');
  h.set('idle');
  h.wait(1100);
  expect(h.shown()).toBe('idle');
});

it('shows a question at once', () => {
  const h = setup('running');
  h.set('waiting_input');
  expect(h.shown()).toBe('waiting_input');
});
