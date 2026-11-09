// @vitest-environment jsdom
// The sidebar's top: the "New agent" row (opens the page) with its quick-start chevron, the Search row, and no duplicate icons in the header.
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

const chev = () => host.querySelector<HTMLButtonElement>('button[aria-label="Quick start menu"]');

describe('sidebar: New agent button', () => {
  it('is the first row at the top; Ctrl N is its tooltip, and a small chevron sits on its right', async () => {
    await render();
    expect(row()!.textContent).toContain('New agent');
    expect(row()!.getAttribute('title')).toMatch(/Ctrl\+N|Ctrl N|⌘N/);
    expect(row()!.querySelector('.ck-row-hint')).toBeNull();
    expect(row()!.classList.contains('ck-row')).toBe(false); // the pane rows and the Inbox row are found by that class
    expect(host.querySelector('.ck-side-top')!.firstElementChild!.contains(row())).toBe(true);
    expect(host.querySelector('.ck-side-head button')).toBeNull(); // no duplicate "+" or search icon in the header
    expect(host.querySelectorAll('button[aria-label="New agent"]')).toHaveLength(1);
    expect(chev()!.getAttribute('title')).toBe('Quick start');
    expect(row()!.contains(chev())).toBe(false); // two buttons, not one inside the other
  });

  it('the label opens the New agent page', async () => {
    const onOpenNewAgent = vi.fn();
    await render({ onOpenNewAgent });
    act(() => row()!.click());
    expect(onOpenNewAgent).toHaveBeenCalledTimes(1);
    expect(onOpenNewAgent).toHaveBeenCalledWith(); // no project: the page picks its own
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it('the chevron opens the quick menu, which has no page row any more', async () => {
    const onOpenNewAgent = vi.fn();
    await render({ onOpenNewAgent });
    expect(host.querySelector('[role="menu"]')).toBeNull();
    act(() => chev()!.click());
    expect(host.querySelector('[role="menu"]')).not.toBeNull();
    expect(chev()!.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('[data-testid="menu-open-page"]')).toBeNull();
    expect(onOpenNewAgent).not.toHaveBeenCalled();
    act(() => chev()!.click());
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
