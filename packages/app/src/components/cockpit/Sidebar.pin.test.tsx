// @vitest-environment jsdom
// Pinned chats in the sidebar: the pane menu's Pin / Unpin, the Pinned group at the top, the pin icon, and the saving.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { GitState, ShipApi } from '../../lib/ship-api';
import { LS_PINNED_PANES } from '../../lib/pinnedPanes';
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
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function fakeApi(names: Record<string, string> = { a: 'Alpha', b: 'Beta', c: 'Gamma' }): CockpitApi {
  const mk = (id: string, status: string) => ({
    info: { id, agent_type: 'codex', pid: 1, status, created_at: 1, last_output_at: null, cwd: 'C:\work\shop', cols: 80, rows: 24, title: null } as unknown as PaneInfo,
    status,
  });
  const panes = [mk('a', 'idle'), mk('b', 'running'), mk('c', 'idle')];
  return {
    registry: { paneList: panes, panes: new Map(panes.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map(Object.entries(names)),
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

const ship = {
  recent: vi.fn(async () => []),
  gitState: vi.fn(async () => 'repo' as unknown as GitState),
  gitInitPlan: vi.fn(),
  gitInit: vi.fn(),
  forget: vi.fn(),
  pickFolder: vi.fn(),
} as unknown as ShipApi;

async function render(c: CockpitApi) {
  await act(async () => root.render(<Sidebar c={c} onOpenPalette={() => {}} ship={ship} />));
  await act(async () => {});
}
const titles = () => [...host.querySelectorAll('button.ck-row .ck-row-title')].map((n) => n.textContent);
const captions = () => [...host.querySelectorAll('.ck-caption')].map((n) => n.textContent);
const rowOf = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button.ck-row')].find((b) => b.querySelector('.ck-row-title')?.textContent === name)!;
const rightClick = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
const menuItem = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === label);
const pin = async (name: string) => {
  await act(async () => rightClick(rowOf(name)));
  await act(async () => menuItem('Pin')!.click());
};

describe('pinned chats', () => {
  it('moves a pinned chat to a Pinned group at the top and shows its pin icon', async () => {
    await render(fakeApi());
    expect(captions()).toEqual(['Working', 'Idle']);
    expect(titles().slice(1)).toEqual(['Beta', 'Alpha', 'Gamma']);
    await pin('Gamma');
    expect(captions()[0]).toBe('Pinned');
    expect(titles().slice(1)).toEqual(['Gamma', 'Beta', 'Alpha']);
    expect(rowOf('Gamma').querySelector('[aria-label="Pinned"]')).not.toBeNull();
    expect(rowOf('Alpha').querySelector('[aria-label="Pinned"]')).toBeNull();
  });

  it('puts the newest pin first, and Unpin sends the chat back to its group', async () => {
    await render(fakeApi());
    await pin('Alpha');
    await pin('Beta');
    expect(titles().slice(1)).toEqual(['Beta', 'Alpha', 'Gamma']);
    await act(async () => rightClick(rowOf('Beta')));
    expect(menuItem('Pin')).toBeUndefined();
    await act(async () => menuItem('Unpin')!.click());
    expect(titles().slice(1)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(captions()).toEqual(['Pinned', 'Working', 'Idle']);
    expect(rowOf('Beta').querySelector('[aria-label="Pinned"]')).toBeNull();
  });

  it('is saved by the chat id and read again on the next start, and a rename keeps it', async () => {
    await render(fakeApi());
    await pin('Gamma');
    expect(JSON.parse(localStorage.getItem(LS_PINNED_PANES)!)).toEqual(['c']);
    act(() => root.unmount());
    root = createRoot(host);
    await render(fakeApi({ a: 'Alpha', b: 'Beta', c: 'Gamma renamed' }));
    expect(titles().slice(1)).toEqual(['Gamma renamed', 'Beta', 'Alpha']);
    expect(captions()[0]).toBe('Pinned');
  });

  it('opens the menu from the keyboard and Pin is the first action', async () => {
    await render(fakeApi());
    await act(async () => rightClick(rowOf('Alpha')));
    expect(document.activeElement).toBe(menuItem('Pin'));
    await act(async () => menuItem('Pin')!.click());
    expect(titles()[1]).toBe('Alpha');
  });
});
