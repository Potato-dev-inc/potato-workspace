// @vitest-environment jsdom
// The pane's ⋯ menu carries the agent's bell: four rows, the level in use marked, and a pick is remembered.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { BELL_KEY, resetNotifyStoreForTest } from '../../lib/notify-store';
import { PaneView } from './PaneView';

const invoke = vi.fn(async (cmd: string) => (cmd === 'checkpoints_list' ? { state: 'ok', message: '', items: [] } : null) as unknown);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const mk = (id: string, title: string, parent?: string) => ({
  status: 'idle',
  info: { id, agent_type: 'claude', status: 'idle', pid: 1, created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 80, rows: 24, title, parent_pane_id: parent },
});

function cockpit(list: ReturnType<typeof mk>[], selected: string): CockpitApi {
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map(list.map((p) => [p.info.id, 'Claude'])),
    activities: {},
    previews: {},
    asked: { questions: [] },
    prompts: {},
    statusSince: new Map(),
    now: 12_000,
    selectedId: selected,
    mode: 'orchestration',
    select: vi.fn(),
    notify: vi.fn(),
  } as unknown as CockpitApi;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
  localStorage.removeItem(BELL_KEY);
  resetNotifyStoreForTest();
  invoke.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.removeItem(BELL_KEY);
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});

const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });

async function openMore(): Promise<void> {
  const more = host.querySelector<HTMLButtonElement>('button[aria-label="More"]')!;
  expect(more).not.toBeNull();
  await act(async () => more.click());
}

function menuRow(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) => b.textContent?.trim() === label);
}

describe('pane ⋯ menu: the agent bell', () => {
  it('a plain agent starts at everything and marks it in use', async () => {
    const c = cockpit([mk('p', 'Refactor auth')], 'p');
    await act(async () => root.render(<PaneView c={c} paneId="p" />));
    await flush();
    await openMore();
    expect(menuRow('Alerts: Everything (now)')).toBeDefined();
    expect(menuRow('Alerts: Only when it needs me')).toBeDefined();
    expect(menuRow('Alerts: Silent')).toBeDefined();
  });

  it('a helper starts at only when it needs me', async () => {
    const c = cockpit([mk('p', 'Refactor auth'), mk('h', 'Check tests', 'p')], 'h');
    await act(async () => root.render(<PaneView c={c} paneId="h" />));
    await flush();
    await openMore();
    expect(menuRow('Alerts: Only when it needs me (now)')).toBeDefined();
  });

  it('picking a level remembers it for the helpers of that agent only', async () => {
    const c = cockpit([mk('p', 'Refactor auth'), mk('h', 'Check tests', 'p')], 'h');
    await act(async () => root.render(<PaneView c={c} paneId="h" />));
    await flush();
    await openMore();
    await act(async () => menuRow('Alerts: Silent')!.click());
    expect(invoke).toHaveBeenCalledWith('notify_bell_set', { key: 'helper:claude', level: 'silent' });
    await openMore();
    expect(menuRow('Alerts: Silent (now)')).toBeDefined();
  });
});
