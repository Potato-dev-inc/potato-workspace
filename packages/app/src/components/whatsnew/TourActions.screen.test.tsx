// @vitest-environment jsdom
// "Try it" on every What's new card, through the real Feature guide and the real screens that own each action:
// the chat pane (right panel, page beside the chat, Files, Point), the work area (split tip), the View menu and the
// usage strip. Each button must DO something visible, and the host must say nothing is missing.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { useEnglish } from '../../i18n/test-utils';
import { resetArtifactSideForTests } from '../../lib/artifact-side';
import { resetFileTabs } from '../../lib/file-tabs';
import { resetWhatsNewForTests } from '../../whatsnew/store';
import { PaneView, forgetRememberedTabs } from '../cockpit/PaneView';
import { UsageBar } from '../cockpit/UsageBar';
import { resetRailFoldForTests } from '../cockpit/rail/railFold';
import { ViewModeToggle } from '../chat/ViewModeToggle';
import { WorkAreaDrop, SPLIT_TIP_MS } from '../dnd/WorkAreaDrop';
import { FeatureGuide } from './FeatureGuide';

const NOW = Date.now();
const SNAP = {
  refreshed_at_ms: NOW,
  rows: [{ agent_id: 'codex', label: 'Codex CLI', account_id: null, account_label: null, state: 'ok', reason: null, windows: [{ name: '5-hour', used_percent: 40, minutes: 300, resets_at_ms: NOW + 3_600_000, reset_since: false }], plan: 'plus', observed_at_ms: NOW, limited_until_ms: null, page: null }],
};
const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === 'artifacts_sync') return [{ id: 'plan', title: 'Launch plan', kind: 'html', createdAt: 't', updatedAt: 't', versions: [{ n: 1, at: 't', bytes: 5 }] }];
  if (cmd === 'artifacts_read') return { artifact: { id: args?.id, title: 'Launch plan', kind: 'html', createdAt: 't', updatedAt: 't', versions: [{ n: 1, at: 't', bytes: 5 }] }, version: 1, content: '<h1>plan</h1>', path: 'C:/proj/plan/v1.html' };
  if (cmd === 'project_files_search') return [{ path: 'notes/report.docx', absPath: '/work/shop/notes/report.docx', name: 'report.docx', size: 10 }];
  if (cmd === 'usage_snapshot') return SNAP;
  if (cmd === 'files_list') return { truncated: false, entries: [] };
  if (cmd === 'files_marks') return [];
  if (cmd === 'session_chat_open') return { available: false, reason: 'No chat in this test', items: [] };
  if (cmd === 'checkpoints_list') return { state: 'ok', message: '', items: [] };
  if (cmd === 'pane_git_branch') return 'main';
  return null;
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));
vi.mock('../../lib/settings', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/settings')>();
  return { ...real, loadSettings: async () => ({ ...(await real.loadSettings()), show_usage_bar: true }) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const pane = { status: 'idle', info: { id: 'p', agent_type: 'claude', status: 'idle', pid: 1, created_at: 1, last_output_at: null, cwd: '/work/shop', cols: 80, rows: 24, title: 'p' } };
const cockpit = (): CockpitApi =>
  ({
    registry: { paneList: [pane], panes: new Map([['p', pane]]), initialReady: true },
    names: new Map([['p', 'Claude']]),
    activities: {},
    previews: {},
    asked: { questions: [] },
    prompts: {},
    statusSince: new Map(),
    now: 12_000,
    selectedId: 'p',
    mode: 'orchestration',
    select: vi.fn(),
    notify: vi.fn(),
  }) as unknown as CockpitApi;

let host: HTMLDivElement;
let root: Root;
const notify = vi.fn();
beforeEach(() => {
  useEnglish();
  window.localStorage.clear();
  forgetRememberedTabs();
  resetFileTabs();
  resetArtifactSideForTests();
  resetRailFoldForTests();
  resetWhatsNewForTests();
  notify.mockClear();
  invoke.mockClear();
  Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const tryCard = async (id: string) => {
  await act(async () => host.querySelector<HTMLButtonElement>(`article[data-id="${id}"] .wn-gtry`)!.click());
  await flush();
};
const missing = () => notify.mock.calls.some((c) => String(c[0]).includes('not ready'));

async function mountAll(opts: { rail?: boolean } = {}) {
  if (opts.rail === false) window.localStorage.setItem('pm.sessionRail.open', '0');
  await act(async () =>
    root.render(
      <>
        <FeatureGuide notify={notify} />
        <ViewModeToggle mode="summary" onChange={() => {}} />
        <PaneView c={cockpit()} paneId="p" />
        <WorkAreaDrop shown={['p']} remembered={50} partnerOf={() => null} nameOf={() => 'Claude'} onDrop={() => {}} />
        <UsageBar />
      </>,
    ),
  );
  await flush();
  await flush();
}

describe('Try it, through the Feature guide and the real screens', () => {
  it('"Show the panel" (rail.open) opens the right panel when it is hidden', async () => {
    await mountAll({ rail: false });
    expect(host.querySelector('[data-testid="session-rail"]')).toBeNull();
    await tryCard('right-panel');
    expect(host.querySelector('[data-testid="session-rail"]')).not.toBeNull();
    expect(missing()).toBe(false);
  });

  it('"Show me" (split.hint) draws the half-and-half tip for a few seconds, then it goes', async () => {
    await mountAll();
    expect(host.querySelector('[data-testid="work-drop-tip"]')).toBeNull();
    await tryCard('split-drag');
    expect(host.querySelector('[data-testid="work-drop-tip"]')?.textContent).toContain('Drop it on the middle line');
    expect(missing()).toBe(false);
    await act(async () => void (await new Promise((r) => setTimeout(r, SPLIT_TIP_MS + 100))));
    expect(host.querySelector('[data-testid="work-drop-tip"]')).toBeNull();
  }, 15_000);

  it('"Open a sample" (artifact.sample) opens the newest page beside the chat', async () => {
    await mountAll();
    expect(host.querySelector('[data-testid="artifact-side"]')).toBeNull();
    await tryCard('artifact-side');
    expect(host.querySelector('[data-testid="artifact-side"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="artifact-side-view"]')?.textContent).toContain('Launch plan');
  });

  it('"Try it" on Point and fix (point.start) opens the page already waiting for a click', async () => {
    await mountAll();
    await tryCard('point-fix');
    await flush();
    const point = host.querySelector<HTMLButtonElement>('[data-testid="artifact-point"]');
    expect(point?.getAttribute('aria-pressed')).toBe('true');
  });

  it('"Open a sample" on Word files (files.sample) shows the Files card and opens a .docx from the project', async () => {
    await mountAll({ rail: false });
    await tryCard('word-pages');
    expect(invoke).toHaveBeenCalledWith('project_files_search', { paneId: 'p', query: '.docx', limit: 1 });
    expect(host.querySelector('[data-testid="session-rail"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="file-tabs"]')?.textContent).toContain('report.docx');
  });

  it('"Change the view" (chat.viewMenu) opens the View menu', async () => {
    await mountAll();
    expect(host.querySelector('.ck-chat-mode-menu')).toBeNull();
    await tryCard('view-summary');
    expect(host.querySelector('.ck-chat-mode-pill')?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.ck-chat-mode-menu')).not.toBeNull();
  });

  it('"Change the view" also works where the menu is drawn in the top layer (a narrow header)', async () => {
    await act(async () => root.render(<><FeatureGuide notify={notify} /><ViewModeToggle mode="summary" onChange={() => {}} compact /></>));
    await flush();
    await tryCard('view-summary');
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it('"Open usage" (usage.open) opens the usage card from the strip', async () => {
    await mountAll();
    expect(host.querySelector('.ck-statusbar button[aria-expanded="true"]')).toBeNull();
    await tryCard('usage-button');
    expect(host.querySelector('.ck-statusbar button[aria-expanded="true"]')).not.toBeNull();
    expect(missing()).toBe(false);
  });

  it('says so in plain words when nothing on screen can answer (no chat open)', async () => {
    await act(async () => root.render(<FeatureGuide notify={notify} />));
    await flush();
    await tryCard('right-panel');
    await tryCard('artifact-side');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('not ready'));
  });
});
