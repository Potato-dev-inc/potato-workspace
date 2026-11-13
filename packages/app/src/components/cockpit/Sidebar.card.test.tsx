// @vitest-environment jsdom
// The project card (#17): name and what changed, the branch, agents grouped by branch and copy, and a folded card that
// shows the agents' icons and its loudest signal.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { GitState, ShipApi } from '../../lib/ship-api';
import { LS_GROUP_BY, LS_PROJECTS_FOLDED, LS_SIDEBAR_PROJECTS } from '../../lib/sidebarProjects';
import { cockpitApi } from '../../lib/cockpit-api';
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
  vi.restoreAllMocks();
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
  ];
  return {
    registry: { paneList: panes, panes: new Map(panes.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map([
      ['a', 'Alpha'],
      ['b', 'Beta'],
      ['c', 'Gamma'],
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


const copy = {
  handle: 'w1',
  branch: 'fix/login',
  base: 'main',
  repo: SHOP,
  path: 'C:\work\shop-w1',
  exists: true,
  state: 'active',
  summary: { files_changed: 3, additions: 124, deletions: 18 },
  pr: { number: 212, url: 'u', draft: false, base: 'main', created_at_ms: 1, checks: { state: 'passing', items: [], checked_at_ms: 1 } },
};
beforeEach(() => {
  localStorage.setItem(LS_SIDEBAR_PROJECTS, JSON.stringify([{ path: SHOP }, { path: DOCS }]));
  const branches: Record<string, string> = { a: 'main', c: 'dev' };
  vi.spyOn(cockpitApi, 'paneGitBranch').mockImplementation(async (id: string) => branches[id] ?? null);
  vi.spyOn(cockpitApi, 'paneWorktree').mockImplementation(async (id: string) => (id === 'b' ? (copy as never) : null));
});

describe('sidebar: project card', () => {
  it('line one names the project and what changed', async () => {
    await render();
    const head = group('shop').querySelector('.ck-proj-head')!;
    expect(head.querySelector('.ck-proj-name')!.textContent).toBe('shop');
    expect(head.querySelector('.ck-proj-changes .ck-add')!.textContent).toBe('+124');
    expect(head.querySelector('.ck-proj-changes .ck-del')!.textContent).toBe('−18');
    expect(group('docs').querySelector('.ck-proj-changes')).toBeNull();
  });

  it('agents sit inside, grouped by branch and copy, with the pull request when it is known', async () => {
    await render();
    const heads = [...group('shop').querySelectorAll('.ck-branch-group')].map((g) => g.querySelector('.ck-branch-head')!.textContent);
    expect(heads).toEqual(['mainprimary', 'fix/logincopyPR #212 · checks pass']);
    expect(titles(group('shop').querySelectorAll('.ck-branch-group')[1] as HTMLElement)).toEqual(['Beta']);
  });

  it('one plain branch is named once on a second line instead of being repeated', async () => {
    await render();
    expect(group('docs').querySelector('.ck-branch-group')).toBeNull();
    expect(group('docs').querySelector('.ck-proj-meta')!.textContent).toBe('devprimary');
  });

  it('a folded card shows the icons of its agents and its loudest signal', async () => {
    await render();
    await click(group('shop').querySelector<HTMLButtonElement>('.ck-proj-toggle')!);
    const head = group('shop').querySelector('.ck-proj-head')!;
    expect(titles(group('shop'))).toEqual([]);
    expect(head.querySelectorAll('.ck-proj-icons svg, .ck-proj-icons [data-mark]').length).toBe(2);
    expect(head.querySelector('.ck-proj-signal')!.textContent).toBe('Needs you');
    expect(head.querySelector('.ck-proj-signal')!.classList.contains('is-needs')).toBe(true);
  });

  it('asks for branch and changes once per status, not on every tick', async () => {
    await render();
    const calls = vi.mocked(cockpitApi.paneWorktree).mock.calls.length;
    await render(fakeApi({ now: 120_000 }));
    expect(vi.mocked(cockpitApi.paneWorktree).mock.calls.length).toBe(calls);
  });
});
