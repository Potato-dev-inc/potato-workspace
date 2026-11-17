// @vitest-environment jsdom
// The sidebar's ... menu (UX plan item 16), through the real Sidebar: three short labelled groups, most used first;
// one clear Browser row that opens the globe browser; no Theme rows (theme lives in Settings > Look and feel); and
// every action the menu had before still opens its page. Popovers close through useDismissable, so Escape closes it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ShipApi } from '../../lib/ship-api';
import { openBrowserWindow } from '../../lib/browser-check';
import { Sidebar } from './Sidebar';

vi.mock('../../lib/browser-check', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/browser-check')>();
  return { ...orig, openBrowserWindow: vi.fn() };
});

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
  vi.mocked(openBrowserWindow).mockReset();
  vi.mocked(openBrowserWindow).mockResolvedValue(undefined);
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
    setMode: vi.fn(async () => {}),
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

const handlers = () => ({
  onOpenMemory: vi.fn(),
  onOpenPlans: vi.fn(),
  onOpenScores: vi.fn(),
  onOpenRoutines: vi.fn(),
  onOpenDoctor: vi.fn(),
  onOpenSpaces: vi.fn(),
  onOpenReview: vi.fn(),
});

async function mount(c: CockpitApi, extra: ReturnType<typeof handlers>) {
  await act(async () =>
    root.render(
      <Sidebar c={c} onOpenPalette={() => {}} ship={ship} spaces={{ enabled: true }} spacesOpen={false} {...extra} />,
    ),
  );
  await act(async () => {});
}

const more = () => host.querySelector<HTMLButtonElement>('button[aria-label="More"]')!;
const menu = () => document.querySelector<HTMLElement>('[role="menu"][aria-label="More"]');
async function openMore() {
  if (more().getAttribute('aria-expanded') !== 'true') await act(async () => more().click());
  await act(async () => {});
}
const item = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.trim() === label);
const groups = () => [...document.querySelectorAll<HTMLElement>('[data-testid^="more-group-"]')];

describe('the sidebar ... menu: short labelled groups', () => {
  it('is Go to, Tools, Mode, most used first, with one row per action', async () => {
    await mount(fakeApi(), handlers());
    await openMore();
    expect(groups().map((g) => g.getAttribute('aria-label'))).toEqual(['Go to', 'Tools', 'Mode']);
    expect(groups().map((g) => g.querySelector('.ck-menu-cap')?.textContent?.trim())).toEqual(['Go to', 'Tools', 'Mode']);
    expect([...groups()[0].querySelectorAll('[role="menuitem"]')].map((b) => b.textContent?.trim())).toEqual([
      'Browser',
      'Your plans',
      'Routines',
      'Scores',
      'Project',
      'Spaces',
    ]);
    expect([...groups()[1].querySelectorAll('[role="menuitem"]')].map((b) => b.textContent?.trim())).toEqual(['Review', 'Set up agents']);
    expect([...groups()[2].querySelectorAll('[role="radio"]')].map((b) => b.textContent?.trim())).toEqual(['One window', 'A window per agent']);
  });

  it('does not repeat Theme (Settings > Look and feel > Appearance owns it)', async () => {
    await mount(fakeApi(), handlers());
    await openMore();
    expect(menu()!.textContent).not.toContain('Theme');
    expect(menu()!.querySelectorAll('[role="menuitemradio"]')).toHaveLength(0);
  });

  it('keeps every action it had before: each row opens its page', async () => {
    const h = handlers();
    await mount(fakeApi(), h);
    const expected: Array<[string, ReturnType<typeof vi.fn>]> = [
      ['Your plans', h.onOpenPlans],
      ['Routines', h.onOpenRoutines],
      ['Scores', h.onOpenScores],
      ['Project', h.onOpenMemory],
      ['Spaces', h.onOpenSpaces],
      ['Set up agents', h.onOpenDoctor],
    ];
    for (const [label, spy] of expected) {
      await openMore();
      expect(item(label), label).toBeTruthy();
      await act(async () => item(label)!.click());
      expect(spy, label).toHaveBeenCalledTimes(1);
      expect(menu(), label).toBeNull();
    }
  });

  it('closes with Escape', async () => {
    await mount(fakeApi(), handlers());
    await openMore();
    expect(menu()).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(menu()).toBeNull();
  });
});

describe('the Browser row', () => {
  it('is the first row of Go to and opens the same globe browser with no address', async () => {
    await mount(fakeApi(), handlers());
    await openMore();
    expect(groups()[0].querySelector('[role="menuitem"]')?.textContent?.trim()).toBe('Browser');
    await act(async () => item('Browser')!.click());
    await act(async () => {});
    expect(openBrowserWindow).toHaveBeenCalledTimes(1);
    expect(openBrowserWindow).toHaveBeenCalledWith();
    expect(menu()).toBeNull();
  });

  it('says in one plain sentence when the window does not open', async () => {
    const c = fakeApi();
    vi.mocked(openBrowserWindow).mockRejectedValueOnce(new Error('Desktop shell required: browser_open_window'));
    await mount(c, handlers());
    await openMore();
    await act(async () => item('Browser')!.click());
    await act(async () => {});
    expect(c.notify).toHaveBeenCalledWith('The browser did not open.');
    expect(menu()).toBeNull();
  });
});
