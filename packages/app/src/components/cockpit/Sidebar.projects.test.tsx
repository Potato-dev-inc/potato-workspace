// @vitest-environment jsdom
// The Projects view of the sidebar: groups by folder, Add project, folding, the group-by switch, the row's hover menu
// and the footer's More menu.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { GitState, ShipApi } from '../../lib/ship-api';
import { LS_GROUP_BY, LS_PROJECTS_FOLDED, LS_SIDEBAR_PROJECTS } from '../../lib/sidebarProjects';
import { currentUndo, resetUndoBar, runUndo } from '../../lib/undo-bar';
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
  resetUndoBar();
  host.remove();
});

const SHOP = 'C:\\work\\shop';
const DOCS = 'C:\\work\\docs';

function fakeApi(extra: Partial<CockpitApi> = {}): CockpitApi {
  const mk = (id: string, status: string, cwd: string | null) => ({
    info: { id, agent_type: 'codex', pid: 1, status, created_at: 1, last_output_at: null, cwd, cols: 80, rows: 24, title: null } as unknown as PaneInfo,
    status,
  });
  const panes = [
    mk('a', 'waiting_input', `${SHOP}\\app`),
    mk('b', 'running', SHOP),
    mk('c', 'idle', DOCS),
    mk('d', 'idle', null),
  ];
  return {
    registry: { paneList: panes, panes: new Map(panes.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map([
      ['a', 'Alpha'],
      ['b', 'Beta'],
      ['c', 'Gamma'],
      ['d', 'Delta'],
    ]),
    asked: { questions: [] },
    launchEntries: [{ type: 'codex', label: 'Codex', icon: null }],
    readyAgents: new Set<string>(['codex']),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select: vi.fn(),
    interrupt: vi.fn(async () => {}),
    setMode: vi.fn(async () => {}),
    newAgent: vi.fn(async () => null),
    prompts: {},
    statusSince: new Map(),
    now: 60_000,
    spawn: null,
    toasts: [],
    notify: vi.fn(),
    bridgeLine: '',
    ...extra,
  } as unknown as CockpitApi;
}

const pickFolder = vi.fn();
const ship = {
  recent: vi.fn(async () => []),
  gitState: vi.fn(async () => 'repo' as unknown as GitState),
  gitInitPlan: vi.fn(),
  gitInit: vi.fn(),
  forget: vi.fn(),
  pickFolder,
} as unknown as ShipApi;

type Props = Partial<React.ComponentProps<typeof Sidebar>>;
async function render(c: CockpitApi = fakeApi(), props: Props = {}) {
  await act(async () => root.render(<Sidebar c={c} onOpenPalette={() => {}} ship={ship} {...props} />));
  await act(async () => {});
}
const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
const byLabel = (label: string) => q<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const heads = () => [...host.querySelectorAll('.ck-proj-name')].map((n) => n.textContent);
const titles = (scope: ParentNode = host) => [...scope.querySelectorAll('.ck-row-title')].map((n) => n.textContent);
const group = (name: string) => host.querySelector<HTMLElement>(`.ck-proj[aria-label="${name}"]`)!;
const click = async (el: HTMLElement) => {
  await act(async () => el.click());
  await act(async () => {});
};

describe('sidebar: Projects view', () => {
  it('is the default, and groups agents by the folder they work in', async () => {
    localStorage.setItem(LS_SIDEBAR_PROJECTS, JSON.stringify([{ path: SHOP }]));
    await render();
    expect(heads()).toEqual(['shop', 'docs', 'Other']);
    expect(titles(group('shop'))).toEqual(['Alpha', 'Beta']);
    expect(titles(group('docs'))).toEqual(['Gamma']);
    expect(titles(group('Other'))).toEqual(['Delta']);
    // Only the row that needs the person says so (the pill); the groups are not headed "Needs you".
    expect(host.querySelectorAll('.ck-row-pill')).toHaveLength(1);
    expect(q('.ck-sechead-text')!.textContent).toBe('Projects');
  });

  it('shows an added project that has no agents with a quiet "New agent" row that opens the menu for that folder', async () => {
    localStorage.setItem(LS_SIDEBAR_PROJECTS, JSON.stringify([{ path: 'C:\\work\\empty' }]));
    await render();
    expect(group('empty').textContent).not.toContain('No agents');
    const row = group('empty').querySelector<HTMLButtonElement>('[data-testid="proj-new-agent"]')!;
    expect(row.textContent).toBe('New agent');
    await click(row);
    expect(q('[role="menu"]')).not.toBeNull();
    expect(q('[role="menu"]')!.textContent).toContain('empty');
  });

  it('marks the row states: one needs you (bold), one working, one idle', async () => {
    await render();
    const mark = (title: string) =>
      [...host.querySelectorAll('button.ck-row')].find((b) => b.querySelector('.ck-row-title')?.textContent === title)!.querySelector('[role="img"]')!.getAttribute('aria-label');
    expect(mark('Alpha')).toBe('Needs you');
    expect(mark('Beta')).toBe('Working');
    expect(mark('Gamma')).toBe('Idle');
    const alpha = [...host.querySelectorAll('button.ck-row')].find((b) => b.querySelector('.ck-row-title')?.textContent === 'Alpha')!;
    expect(alpha.classList.contains('is-needs')).toBe(true);
    // No two-letter tag any more: the agent's name is in the tooltip, and a needs-you row says so in a pill instead of the time.
    expect(alpha.querySelector('.ck-row-tag')).toBeNull();
    expect(alpha.querySelector('.ck-row-main')!.getAttribute('title')).toContain('Codex');
    expect(alpha.querySelector('.ck-row-pill')!.textContent).toBe('Needs you');
    expect(alpha.querySelector('.ck-row-time')).toBeNull();
  });

  it('gives the project "+" the name of its folder', async () => {
    localStorage.setItem(LS_SIDEBAR_PROJECTS, JSON.stringify([{ path: SHOP }]));
    await render();
    const plus = byLabel('New agent in shop');
    expect(plus.getAttribute('title')).toBe('New agent in shop');
  });
});

describe('sidebar: Add project', () => {
  it('is the last row of the project list, and the Projects heading has the same action as an icon', async () => {
    await render();
    const rows = [...host.querySelectorAll('.ck-group')].find((g) => g.querySelector('.ck-proj'))!;
    expect(rows.lastElementChild).toBe(q('[data-testid="side-add-project"]'));
    expect(q('.ck-side-top [data-testid="side-add-project"]')).toBeNull();
    pickFolder.mockResolvedValue({ path: DOCS, name: 'docs' });
    await click(byLabel('Add project'));
    expect(pickFolder).toHaveBeenCalled();
    pickFolder.mockClear();
  });

  it('opens the folder picker, adds the folder and remembers it', async () => {
    pickFolder.mockResolvedValue({ path: DOCS, name: 'docs' });
    await render();
    await click(q('[data-testid="side-add-project"]')!);
    expect(pickFolder).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(LS_SIDEBAR_PROJECTS)!)).toEqual([{ path: DOCS }]);
    // The added folder moves to the front, ahead of the folders that were only seen.
    expect(heads()[0]).toBe('docs');
    expect(group('docs').querySelector('.ck-proj-toggle')).not.toBeNull();
  });

  it('adds nothing when the picker is cancelled', async () => {
    pickFolder.mockResolvedValue(null);
    await render();
    await click(q('[data-testid="side-add-project"]')!);
    expect(localStorage.getItem(LS_SIDEBAR_PROJECTS)).toBeNull();
  });

  it('says so, in plain words, when there is no picker', async () => {
    pickFolder.mockRejectedValue(new Error('Desktop shell required'));
    const c = fakeApi();
    await render(c);
    await click(q('[data-testid="side-add-project"]')!);
    expect(c.notify).toHaveBeenCalledWith('Could not open the folder picker here.');
  });

  it('lets a folder that was only seen be added from its menu, and an added one renamed or removed', async () => {
    await render();
    await click(byLabel('More for docs'));
    await click([...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === 'Add to sidebar')!);
    expect(JSON.parse(localStorage.getItem(LS_SIDEBAR_PROJECTS)!)).toEqual([{ path: DOCS }]);

    await click(byLabel('More for docs'));
    await click([...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === 'Rename')!);
    const input = q<HTMLInputElement>('.ck-proj-rename')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'Docs site');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(JSON.parse(localStorage.getItem(LS_SIDEBAR_PROJECTS)!)).toEqual([{ path: DOCS, name: 'Docs site' }]);

    await click(byLabel('More for Docs site'));
    await click([...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === 'Remove from sidebar')!);
    expect(JSON.parse(localStorage.getItem(LS_SIDEBAR_PROJECTS)!)).toEqual([]);
  });

  it('Remove from sidebar shows the undo bar, and Undo puts the project back exactly as it was', async () => {
    localStorage.setItem(LS_SIDEBAR_PROJECTS, JSON.stringify([{ path: DOCS, name: 'Docs site' }, { path: SHOP }]));
    await render();
    await click(byLabel('More for Docs site'));
    await click([...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === 'Remove from sidebar')!);
    expect(JSON.parse(localStorage.getItem(LS_SIDEBAR_PROJECTS)!)).toEqual([{ path: SHOP }]);
    expect(currentUndo()?.text).toBe('Removed Docs site from the sidebar');
    await act(async () => {
      runUndo();
    });
    expect(JSON.parse(localStorage.getItem(LS_SIDEBAR_PROJECTS)!)).toEqual([{ path: DOCS, name: 'Docs site' }, { path: SHOP }]);
  });

  it('the "+" on a project opens the New agent page with that project', async () => {
    const onOpenNewAgent = vi.fn();
    await render(undefined, { onOpenNewAgent });
    await click(byLabel('New agent in shop'));
    expect(onOpenNewAgent).toHaveBeenCalledWith({ path: SHOP, name: 'shop' });
    expect(q('[role="menu"]')).toBeNull();
  });

  it('the empty-project "New agent" row opens the page with that project', async () => {
    localStorage.setItem(LS_SIDEBAR_PROJECTS, JSON.stringify([{ path: 'C:\\work\\empty' }]));
    const onOpenNewAgent = vi.fn();
    await render(undefined, { onOpenNewAgent });
    await click(group('empty').querySelector<HTMLButtonElement>('[data-testid="proj-new-agent"]')!);
    expect(onOpenNewAgent).toHaveBeenCalledWith({ path: 'C:\\work\\empty', name: 'empty' });
  });

  it('without a page, the "+" on a project opens the quick menu for that folder', async () => {
    await render();
    await click(byLabel('New agent in shop'));
    const menu = q('[role="menu"]')!;
    expect(menu.querySelector('.ck-chip-name')!.textContent).toBe('shop');
  });
});

describe('sidebar: folding a project', () => {
  it('hides the rows, shows the count, and remembers it', async () => {
    localStorage.setItem(LS_SIDEBAR_PROJECTS, JSON.stringify([{ path: SHOP }]));
    await render();
    const toggle = () => group('shop').querySelector<HTMLButtonElement>('.ck-proj-toggle')!;
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    await click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(titles(group('shop'))).toEqual([]);
    expect(group('shop').querySelector('.ck-proj-count')!.textContent).toBe('2');
    expect(JSON.parse(localStorage.getItem(LS_PROJECTS_FOLDED)!)).toHaveLength(1);
    // A new window starts folded the same way.
    act(() => root.unmount());
    root = createRoot(host);
    await render();
    expect(titles(group('shop'))).toEqual([]);
    await click(toggle());
    expect(titles(group('shop'))).toEqual(['Alpha', 'Beta']);
  });
});

describe('sidebar: group by', () => {
  it('switches to Needs you / Working / Idle and back, and remembers the choice', async () => {
    await render();
    expect(heads().length).toBeGreaterThan(0);
    await click(byLabel('Group by status'));
    expect(localStorage.getItem(LS_GROUP_BY)).toBe('status');
    expect(heads()).toEqual([]);
    const captions = [...host.querySelectorAll('.ck-caption')].map((n) => n.textContent);
    expect(captions).toEqual(['Needs you1', 'Working', 'Idle']);
    await click(byLabel('Group by project'));
    expect(localStorage.getItem(LS_GROUP_BY)).toBe('projects');
    expect(heads().length).toBeGreaterThan(0);
  });
});

describe('sidebar: the row menu', () => {
  it('has a button that opens the pane menu, with Handoff from here', async () => {
    await render();
    expect(q('[role="menu"]')).toBeNull();
    await click(byLabel('More for Beta'));
    const items = [...host.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent);
    expect(items).toContain('Handoff from here');
    expect(items).toContain('Pin');
  });
});

describe('sidebar: footer', () => {
  it('has icon buttons with tooltips, and More holds Plans, Scores and the mode', async () => {
    const c = fakeApi();
    const onOpenPlans = vi.fn();
    const onOpenScores = vi.fn();
    await render(c, { onOpenDoctor: () => {}, onOpenMemory: () => {}, onOpenPlans, onOpenScores });
    const foot = q('.ck-side-foot')!;
    for (const label of ['More', 'Settings']) {
      expect(foot.querySelector(`button[aria-label="${label}"]`)?.getAttribute('title')).toBeTruthy();
    }
    expect(foot.textContent).not.toContain('Your plans');
    await click(byLabel('More'));
    const item = (label: string) => [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((b) => b.textContent === label)!;
    const seg = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="radiogroup"] [role="radio"]')].find((b) => b.textContent === label)!;
    expect(document.querySelector('[role="menu"] [role="radiogroup"]')?.getAttribute('title')).toBe('Each agent gets its own window; the main window hides.');
    expect(seg('Orchestration').getAttribute('aria-checked')).toBe('true');
    expect(seg('Individual').getAttribute('aria-checked')).toBe('false');
    await click(seg('Individual'));
    expect(c.setMode).toHaveBeenCalledWith('individual');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await click(byLabel('More'));
    await click(item('Scores'));
    expect(onOpenScores).toHaveBeenCalledTimes(1);
    await click(byLabel('More'));
    await click(item('Your plans'));
    expect(onOpenPlans).toHaveBeenCalledTimes(1);
    // Theme, Project and Set up agents moved into the menu too.
    await click(byLabel('More'));
    expect(['Switch to light', 'Project', 'Set up agents'].every((l) => item(l))).toBe(true);
  });

  it('closes More with Escape', async () => {
    await render();
    await click(byLabel('More'));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('keeps the Connection lost line with its Fix button', async () => {
    const c = fakeApi({ bridgeLine: 'down', openSettings: vi.fn(async () => {}) });
    await render(c);
    q<HTMLButtonElement>('.ck-bridge button')!.click();
    expect(c.openSettings).toHaveBeenCalledWith('bridge');
  });
});
