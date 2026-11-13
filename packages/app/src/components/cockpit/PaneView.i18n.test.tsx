// @vitest-environment jsdom
// Screen-level: the pane header, tabs, More menu, Details sheet and close question in Traditional Chinese.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { HandoffControl } from '../../hooks/useHandoff';
import { t } from '../../i18n';
import { useChinese, useEnglish, visibleEnglish } from '../../i18n/test-utils';
import { PaneView } from './PaneView';
import { headerStateLine, dockLabel } from './pane-chrome';
import { requestPaneAction } from '../../lib/pane-actions';

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

const mk = (id: string, agent: string, status: string, title: string | null = null) => ({
  status,
  info: { id, agent_type: agent, status, pid: 1, created_at: 1, last_output_at: null, cwd: 'C:\work\shop', cols: 100, rows: 30, title },
});

function cockpit(): CockpitApi {
  const list = [mk('p1', 'claude', 'running', 'fix login'), mk('p2', 'codex', 'running', 'tests'), mk('p3', 'opencode', 'waiting_input', 'docs')];
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map([['p1', 'Claude'], ['p2', 'Codex'], ['p3', 'OpenCode']]),
    activities: {},
    previews: {},
    asked: { questions: [] },
    prompts: {},
    statusSince: new Map(),
    now: 1000,
    selectedId: 'p1',
    mode: 'orchestration',
    select: vi.fn(),
    notify: vi.fn(),
    answer: vi.fn(),
    closePane: vi.fn(),
  } as unknown as CockpitApi;
}
const handoff = { mode: 'new_agent', busy: false, allowed: () => true, start: vi.fn() } as unknown as HandoffControl;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useChinese();
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
  useEnglish();
});
const show = async () => {
  await act(async () => root.render(<PaneView c={cockpit()} paneId="p1" handoff={handoff} />));
  await act(async () => {
    await new Promise((r) => setImmediate(r));
  });
};

// Titles and agent names are data; the pane's folder, the run state words and the session rail come from other files.
const EXTRA = ['fix', 'login', 'tests', 'docs', 'shop', 'work', 'Idle', 'Working', 'Waiting', 'Running', 'workshop'];
const header = () => host.querySelector('.ck-pane-head')!;

describe('pane header and tabs in Traditional Chinese', () => {
  it('shows the tabs, the view switch and the action buttons in Chinese', async () => {
    await show();
    expect(host.querySelector('[data-testid="pane-tabs"]')?.getAttribute('aria-label')).toBe(t('pane.tabsLabel'));
    expect(header().querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe(t('pane.viewLabel'));
    expect(header().textContent).toContain(t('pane.tabTerminal'));
    expect(header().querySelector('[data-testid="pane-handoff"]')?.textContent).toBe(t('pane.handOff'));
    expect(header().querySelector('button[aria-haspopup="menu"]')?.getAttribute('aria-label')).toBe(t('pane.more'));
    const dot = host.querySelector('[data-pane-tab="p3"] [data-testid="pane-tab-dot"]');
    expect(dot?.getAttribute('aria-label')).toBe(t('pane.needsYou'));
  });

  it('shows the More menu in Chinese and opens the empty transcript state', async () => {
    await show();
    await act(async () => header().querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
    const items = [...host.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent);
    expect(items).toEqual([t('pane.moreTranscript'), t('pane.moreReceipt'), t('pane.moreHistory')]);
    await act(async () => (host.querySelectorAll<HTMLElement>('[role="menuitem"]')[0]).click());
    await act(async () => {
      await new Promise((r) => setImmediate(r));
    });
    expect(host.textContent).toMatch(new RegExp([t('pane.noTranscript'), t('pane.transcriptUnavailable'), t('pane.loading')].join('|')));
    expect(visibleEnglish(header(), EXTRA)).toEqual([]);
  });

  it('shows the Details sheet and the close question in Chinese', async () => {
    await show();
    await act(async () => requestPaneAction('p1', 'details'));
    expect(host.textContent).toContain(t('pane.detailPid'));
    expect(host.textContent).toContain(t('pane.detailScreen'));
    expect(visibleEnglish(document.body, [...EXTRA, 'Claude'])).toEqual([]);
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === t('pane.done'))!.click());
    await act(async () => requestPaneAction('p1', 'close'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(host.textContent).toContain(t('pane.closeAsk', { name: 'Claude' }));
    expect(host.textContent).toContain(t('pane.keepRunning'));
  });

  it('chrome helpers speak Chinese', () => {
    expect(headerStateLine({ waiting: true, headline: '執行測試', elapsed: '12s', doing: null, fallback: '' })).toBe(t('pane.needsYou') + ' · 執行測試 · 12s');
    expect(dockLabel('ask')).toBe(t('pane.dockAnswer'));
  });
});
