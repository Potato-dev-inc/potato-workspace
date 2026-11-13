// @vitest-environment jsdom
// The watcher ticks the list from the cockpit: a second agent, a split view, a paired phone, a limit in Settings,
// and on the first look it ticks what an existing user already did.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, resetGettingStarted } from '../../../lib/getting-started';
import { useGettingStartedWatch, type WatchDeps } from './useGettingStartedWatch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  resetGettingStarted();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function Probe(props: { ready: boolean; agentCount: number; splitOn: boolean; deps: WatchDeps }) {
  useGettingStartedWatch(props);
  return null;
}
const deps = (over: Partial<WatchDeps> = {}): WatchDeps => ({ phonePaired: async () => false, limitSet: async () => false, hadSplit: () => false, ...over });
const render = (props: Parameters<typeof Probe>[0]) => act(async () => root.render(<Probe {...props} />));

describe('useGettingStartedWatch', () => {
  it('does nothing before the panes are known', async () => {
    await render({ ready: false, agentCount: 5, splitOn: true, deps: deps() });
    expect(getState().seeded).toBe(false);
  });

  it('ticks what an existing user already did, and only that', async () => {
    await render({ ready: true, agentCount: 2, splitOn: false, deps: deps({ phonePaired: async () => true, hadSplit: () => true }) });
    expect(getState()).toMatchObject({ done: ['second', 'side', 'phone'], seeded: true });
  });

  it('a new person with one agent starts with nothing ticked', async () => {
    await render({ ready: true, agentCount: 1, splitOn: false, deps: deps() });
    expect(getState()).toMatchObject({ done: [], seeded: true });
  });

  it('a second agent and a split view tick when they happen', async () => {
    await render({ ready: true, agentCount: 1, splitOn: false, deps: deps() });
    await render({ ready: true, agentCount: 2, splitOn: false, deps: deps() });
    expect(getState().done).toEqual(['second']);
    await render({ ready: true, agentCount: 2, splitOn: true, deps: deps() });
    expect(getState().done).toEqual(['second', 'side']);
  });

  it('a limit and a paired phone tick when settings change', async () => {
    let limit = false;
    const d = deps({ limitSet: async () => limit });
    await render({ ready: true, agentCount: 1, splitOn: false, deps: d });
    expect(getState().done).toEqual([]);
    limit = true;
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await act(async () => {});
    expect(getState().done).toEqual(['limit']);
  });

  it('a lookup that fails ticks nothing', async () => {
    const failing = deps({ phonePaired: vi.fn(async () => Promise.reject(new Error('x'))), limitSet: vi.fn(async () => Promise.reject(new Error('y'))) });
    await render({ ready: true, agentCount: 1, splitOn: false, deps: failing });
    expect(getState().done).toEqual([]);
  });
});
