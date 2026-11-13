// @vitest-environment jsdom
// The Potato mark (#24) in three places: the sidebar's app name, the empty agent list, and the loading screen.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { GitState, ShipApi } from '../../lib/ship-api';
import { LoadingScreen } from '../LoadingScreen';
import { Sidebar } from './Sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('pm.sidebar.groupBy', 'status');
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});


function fakeApi(): CockpitApi {
  return {
    registry: { paneList: [], panes: new Map(), initialReady: true },
    names: new Map(),
    asked: { questions: [] },
    launchEntries: [],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select: vi.fn(),
    interrupt: vi.fn(async () => {}),
    prompts: {},
    statusSince: new Map(),
    now: 60_000,
    spawn: null,
    toasts: [],
    notify: vi.fn(),
    bridgeLine: '',
  } as unknown as CockpitApi;
}
const ship = { recent: vi.fn(async () => []), gitState: vi.fn(async () => 'repo' as unknown as GitState), gitInitPlan: vi.fn(), gitInit: vi.fn(), forget: vi.fn(), pickFolder: vi.fn() } as unknown as ShipApi;

describe('the Potato mark', () => {
  it('sits beside the app name in the sidebar and above the empty-list line', async () => {
    await act(async () => root.render(<Sidebar c={fakeApi()} onOpenPalette={() => {}} ship={ship} />));
    await act(async () => {});
    expect(host.querySelector('.ck-side-head [data-mark="potato"]')).not.toBeNull();
    expect(host.querySelector('.ck-side-head .ck-wordmark')!.textContent).toBe('Potato Workspace');
    expect(host.querySelector('[data-testid="side-empty"] [data-mark="potato"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="side-empty"]')!.textContent).toContain('No agents running.');
  });

  it('leads the loading screen', async () => {
    await act(async () => root.render(<LoadingScreen steps={[]} progress={0.4} />));
    expect(host.querySelector('.pm-boot-header [data-mark="potato"]')).not.toBeNull();
  });
});
