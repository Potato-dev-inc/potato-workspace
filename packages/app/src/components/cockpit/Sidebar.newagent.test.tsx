// @vitest-environment jsdom
// The sidebar's top: the "New agent" button (opens the menu), the Search row, and no duplicate icons in the header.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ShipApi } from '../../lib/ship-api';
import { Sidebar } from './Sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
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
    launchEntries: [{ type: 'codex', label: 'Codex' }],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select: vi.fn(),
    prompts: {},
    statusSince: new Map(),
    now: 60_000,
    spawn: null,
    toasts: [],
    notify: vi.fn(),
    openSettings: vi.fn(async () => {}),
    bridgeLine: '',
  } as unknown as CockpitApi;
}

const ship = { recent: vi.fn().mockResolvedValue([]), gitState: vi.fn().mockResolvedValue('repo') } as unknown as ShipApi;

async function render(props: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  await act(async () => root.render(<Sidebar c={fakeApi()} onOpenPalette={() => {}} ship={ship} {...props} />));
  await act(async () => {});
}
const row = () => host.querySelector<HTMLButtonElement>('[data-testid="side-new-agent"]');
const searchRow = () => host.querySelector<HTMLButtonElement>('[data-testid="side-search"]');
const inboxRow = () => [...host.querySelectorAll<HTMLButtonElement>('button.ck-row')].find((b) => b.textContent?.includes('Inbox'))!;

describe('sidebar: New agent button', () => {
  it('is the first row at the top, says New agent with its shortcut, and is not the header "+"', async () => {
    await render();
    expect(row()!.textContent).toContain('New agent');
    expect(row()!.querySelector('.ck-row-hint')!.textContent).toMatch(/Ctrl N|⌘N/);
    expect(row()!.classList.contains('ck-row')).toBe(false); // the pane rows and the Inbox row are found by that class
    expect(host.querySelector('.ck-side-top')!.firstElementChild!.contains(row())).toBe(true);
    expect(host.querySelector('.ck-side-head button')).toBeNull(); // no duplicate "+" or search icon in the header
    expect(host.querySelectorAll('button[aria-label="New agent"]')).toHaveLength(1);
  });

  it('opens the New agent menu', async () => {
    await render();
    expect(host.querySelector('[role="menu"]')).toBeNull();
    act(() => row()!.click());
    expect(host.querySelector('[role="menu"]')).not.toBeNull();
    expect(row()!.getAttribute('aria-expanded')).toBe('true');
  });

  it('puts the page (Ctrl+N) one row into the menu when the cockpit has it', async () => {
    const onOpenNewAgent = vi.fn();
    await render({ onOpenNewAgent });
    act(() => row()!.click());
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="menu-open-page"]')!.click());
    expect(onOpenNewAgent).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it('is the active row while the page is open, and the Inbox row is then not', async () => {
    await render({ newAgentOpen: false });
    expect(row()!.classList.contains('is-active')).toBe(false);
    expect(inboxRow().classList.contains('is-active')).toBe(true);
    await render({ newAgentOpen: true });
    expect(row()!.classList.contains('is-active')).toBe(true);
    expect(inboxRow().classList.contains('is-active')).toBe(false);
  });
});

describe('sidebar: Search row', () => {
  it('sits under New agent, shows Ctrl K and opens the palette', async () => {
    const onOpenPalette = vi.fn();
    await render({ onOpenPalette });
    expect(row()!.parentElement!.nextElementSibling).toBe(searchRow());
    expect(searchRow()!.textContent).toContain('Search');
    expect(searchRow()!.querySelector('.ck-row-hint')!.textContent).toMatch(/Ctrl K|⌘K/);
    expect(host.querySelector('button[aria-label="Search"]')).toBeNull(); // the header icon is gone
    act(() => searchRow()!.click());
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
  });
});
