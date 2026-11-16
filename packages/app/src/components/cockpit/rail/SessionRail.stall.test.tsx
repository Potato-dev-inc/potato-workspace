// @vitest-environment jsdom
// Screen-level: a helper with no progress shows "Stuck? No progress for N min" with Nudge, Stop and Respawn
// in the rail's Background tasks, rendered through the real SessionRail.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnglish } from '../../../i18n/test-utils';
import { setStalls } from '../../../lib/stalls';
import { SessionRail } from './SessionRail';
import { resetRailFoldForTests } from './railFold';

const invoke = vi.hoisted(() => vi.fn(async (cmd: string) => (cmd === 'stalls_list' ? [] : null) as unknown));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('../../../hooks/useSessionChat', () => ({ useSessionChat: () => ({ model: null, cliVersion: null, usage: null, plan: [], outputs: [], turns: [] }) }));
vi.mock('./usePaneBranch', () => ({ usePaneBranch: () => 'main' }));
vi.mock('../../../lib/pane-jobs', async (orig) => ({ ...(await orig<typeof import('../../../lib/pane-jobs')>()), usePaneJobs: () => ({ p1: [] }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  window.localStorage.clear();
  resetRailFoldForTests();
  invoke.mockClear();
  setStalls(new Map());
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});

const props = {
  paneId: 'p1',
  status: 'running',
  cwd: '/work/shop',
  agentType: 'claude',
  agentName: 'Claude 1',
  accountLabel: null,
  readsChat: true,
  helperOf: null,
  helpers: [
    { id: 'h1', title: 'Sleeper', agent: 'OpenCode', agentType: 'opencode_native', status: 'running' },
    { id: 'h2', title: 'Writer', agent: 'Codex', agentType: 'codex', status: 'running' },
  ],
  onOpenPane: () => {},
};
const mount = async () => {
  await act(async () => root.render(<SessionRail {...props} />));
  await act(async () => {});
};
const notices = () => [...host.querySelectorAll<HTMLElement>('[data-testid="stall-notice"]')];
const press = async (label: string) => act(async () => [...notices()[0].querySelectorAll('button')].find((b) => b.textContent === label)!.click());

describe('Background tasks: a stuck helper', () => {
  it('shows nothing while no helper is stuck', async () => {
    await mount();
    expect(notices()).toEqual([]);
  });

  it('shows the stuck line only under the stuck helper, with the three buttons', async () => {
    await mount();
    await act(async () => setStalls(new Map([['h1', 6]])));
    expect(notices()).toHaveLength(1);
    expect(notices()[0].textContent).toContain('Stuck? No progress for 6 min');
    expect([...notices()[0].querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Nudge', 'Stop', 'Respawn']);
    expect(notices()[0].closest('.rp-helper')!.textContent).toContain('Sleeper');
  });

  it('Nudge, Stop and Respawn call the backend for that helper', async () => {
    await mount();
    await act(async () => setStalls(new Map([['h1', 6]])));
    await press('Nudge');
    expect(invoke).toHaveBeenCalledWith('stall_nudge', { paneId: 'h1' });
    await press('Stop');
    expect(invoke).toHaveBeenCalledWith('stall_stop', { paneId: 'h1' });
    await press('Respawn');
    expect(invoke).toHaveBeenCalledWith('stall_respawn', { paneId: 'h1' });
  });

  it('goes away when the helper makes progress again', async () => {
    await mount();
    await act(async () => setStalls(new Map([['h1', 6]])));
    expect(notices()).toHaveLength(1);
    await act(async () => setStalls(new Map()));
    expect(notices()).toEqual([]);
  });
});
