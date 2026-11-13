// @vitest-environment jsdom
// Screen level, in Traditional Chinese: the sidebar's own words (New agent, Inbox, the section captions, the row marks,
// the row menu, the footer's More menu, the empty state) are translated. Agent and project names are data and stay.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { GitState, ShipApi } from '../../lib/ship-api';
import { LS_GROUP_BY } from '../../lib/sidebarProjects';
import { setLanguagePref } from '../../i18n';
import { t } from '../../i18n';
import { useChinese, useEnglish, visibleEnglish } from '../../i18n/test-utils';
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
  useChinese();
});
afterEach(() => {
  useEnglish();
  act(() => root.unmount());
  host.remove();
});

const SHOP = 'C:\\work\\shop';
const DOCS = 'C:\\work\\docs';
// The agent and project names are data, and "Ctrl" is a keyboard key: they stay as they are in any language.
const DATA_WORDS = ['Alpha', 'Beta', 'Gamma', 'Delta', 'shop', 'docs', 'app', 'Ctrl'];

function fakeApi(extra: Partial<CockpitApi> = {}): CockpitApi {
  const mk = (id: string, status: string, cwd: string | null) => ({
    info: { id, agent_type: 'codex', pid: 1, status, created_at: 1, last_output_at: null, cwd, cols: 80, rows: 24, title: null } as unknown as PaneInfo,
    status,
  });
  const panes = [mk('a', 'waiting_input', `${SHOP}\\app`), mk('b', 'running', SHOP), mk('c', 'idle', DOCS), mk('d', 'idle', null)];
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

const ship = {
  recent: vi.fn(async () => []),
  gitState: vi.fn(async () => 'repo' as unknown as GitState),
  gitInitPlan: vi.fn(),
  gitInit: vi.fn(),
  forget: vi.fn(),
  pickFolder: vi.fn(),
} as unknown as ShipApi;

async function render(c: CockpitApi = fakeApi()) {
  await act(async () => root.render(<Sidebar c={c} onOpenPalette={() => {}} ship={ship} />));
  await act(async () => {});
}
const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);

describe('sidebar in Traditional Chinese', () => {
  it('translates the sidebar words and leaves no English behind, with agents listed by status', async () => {
    localStorage.setItem(LS_GROUP_BY, 'status');
    await render();
    expect(visibleEnglish(host, DATA_WORDS)).toEqual([]);
    expect(q('[data-testid="side-new-agent"]')!.textContent).toContain(t('sidebar.newAgent'));
    expect(q('.ck-row--flat')!.textContent).toContain(t('sidebar.inbox'));
    expect(q('[data-testid="side-search"]')!.textContent).toContain(t('sidebar.search'));
    // The section captions: Needs you, Working, Idle, in Chinese (the count is a separate span).
    expect([...host.querySelectorAll('.ck-caption')].map((c) => c.firstChild?.textContent)).toEqual([t('sidebar.needsYou'), t('sidebar.working'), t('sidebar.idle')]);
    // The row that needs the person says so in Chinese, in its chip and its spoken label.
    expect(q('.ck-row-pill')!.textContent).toBe(t('sidebar.needsYou'));
    expect(q('[data-pane-row="a"]')!.getAttribute('aria-label')).toBe(t('sidebar.rowNeedsYou', { name: 'Alpha' }));
  });

  it('the row menu (right-click) and the footer More menu are in Chinese', async () => {
    localStorage.setItem(LS_GROUP_BY, 'status');
    await render();
    await act(async () => {
      q('[data-pane-row="a"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }));
    });
    const rowMenu = document.querySelector<HTMLElement>('[role="menu"][aria-label="' + t('sidebar.paneActions') + '"]');
    expect(rowMenu).not.toBeNull();
    expect(rowMenu!.textContent).toContain(t('sidebar.rename'));
    expect(rowMenu!.textContent).toContain(t('sidebar.interrupt'));
    expect(visibleEnglish(rowMenu!)).toEqual([]);
    // Close it, then open the footer's More menu.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await act(async () => {
      q<HTMLButtonElement>('button[aria-label="' + t('pane.more') + '"]')!.click();
    });
    await act(async () => {});
    const more = document.querySelector<HTMLElement>('[role="menu"][aria-label="' + t('pane.more') + '"]');
    expect(more).not.toBeNull();
    expect(more!.textContent).toContain(t('sidebar.switchToLight'));
    expect(more!.textContent).toContain(t('sidebar.modeOrchestration'));
    expect(more!.textContent).toContain(t('sidebar.modeIndividual'));
    expect(visibleEnglish(more!)).toEqual([]);
  });

  it('an empty sidebar says in Chinese that no agent is running', async () => {
    await render(fakeApi({ registry: { paneList: [], panes: new Map(), initialReady: true } as unknown as CockpitApi['registry'] }));
    expect(q('[data-testid="side-empty"]')!.textContent).toContain(t('sidebar.noAgentsRunning'));
    expect(visibleEnglish(q('[data-testid="side-empty"]')!)).toEqual([]);
  });
});

describe('switching the language', () => {
  it('switching language re-renders the sidebar in Chinese (and back), live, without a remount', async () => {
    useEnglish();
    await render();
    expect(q('[data-testid="side-new-agent"]')!.textContent).toContain('New agent');
    expect(document.documentElement.lang).toBe('en');
    await act(async () => setLanguagePref('zh-TW', false));
    expect(q('[data-testid="side-new-agent"]')!.textContent).toContain(t('sidebar.newAgent'));
    expect(q('[data-testid="side-new-agent"]')!.textContent).not.toContain('New agent');
    expect(document.documentElement.lang).toBe('zh-TW');
    await act(async () => setLanguagePref('en', false));
    expect(q('[data-testid="side-new-agent"]')!.textContent).toContain('New agent');
  });
});
