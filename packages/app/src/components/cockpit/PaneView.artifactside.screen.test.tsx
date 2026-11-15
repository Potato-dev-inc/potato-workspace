// @vitest-environment jsdom
// A page the agent made opens BESIDE the chat, in the real pane view: the chat (here the pane's main area) stays mounted
// and keeps its place, the page sits between it and the right panel, it can take the full width and still leave the chat
// mounted underneath, and the right panel's "open beside" call (no pane named) lands in the pane on screen.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { PaneView, forgetRememberedTabs } from './PaneView';
import { resetFileTabs } from '../../lib/file-tabs';
import { closeArtifactBeside, openArtifactBeside, resetArtifactSideForTests } from '../../lib/artifact-side';
import { useEnglish } from '../../i18n/test-utils';

const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === 'artifacts_read') {
    return {
      artifact: { id: args?.id, title: 'Launch plan', kind: 'html', createdAt: 't', updatedAt: 't', versions: [{ n: 1, at: 't', bytes: 5 }] },
      version: 1,
      content: '<h1>plan</h1>',
      path: 'C:/proj/.potato/artifacts/plan/v1.html',
    };
  }
  if (cmd === 'artifacts_sync') return [];
  if (cmd === 'files_list') return { truncated: false, entries: [] };
  if (cmd === 'files_marks') return [];
  if (cmd === 'session_chat_open') return { available: false, reason: 'No chat in this test', items: [] };
  if (cmd === 'checkpoints_list') return { state: 'ok', message: '', items: [] };
  if (cmd === 'pane_git_branch') return 'main';
  return null;
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const mk = (id: string) => ({
  status: 'idle',
  info: { id, agent_type: 'claude', status: 'idle', pid: 1, created_at: 1, last_output_at: null, cwd: '/work/shop', cols: 80, rows: 24, title: id },
});
function cockpit(): CockpitApi {
  const list = [mk('p')];
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
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
  } as unknown as CockpitApi;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  window.localStorage.clear();
  forgetRememberedTabs();
  resetFileTabs();
  resetArtifactSideForTests();
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
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const side = () => host.querySelector<HTMLElement>('[data-testid="artifact-side"]');

describe('a page beside the chat, in the pane view', () => {
  it('opens between the chat and the right panel, and the chat is the same mounted node before and after', async () => {
    await act(async () => root.render(<PaneView c={cockpit()} paneId="p" />));
    await flush();
    const term = host.querySelector('[data-testid="term"]')!;
    const body = host.querySelector('.ck-pane-body')!;
    expect(side()).toBeNull();

    await act(async () => void openArtifactBeside('plan', 'p', 'Launch plan'));
    await flush();
    expect(side()).not.toBeNull();
    // Not a tab: the tab row did not grow, and the chat was not replaced.
    expect(host.querySelector('[data-testid="file-tabs"]')).toBeNull();
    expect(host.querySelector('[data-testid="term"]')).toBe(term);
    expect(host.querySelector('.ck-pane-body')).toBe(body);
    expect(host.querySelector('[data-testid="artifact-side-view"]')?.textContent).toContain('Launch plan');
    expect(invoke).toHaveBeenCalledWith('artifacts_read', { paneId: 'p', id: 'plan', version: undefined });

    // Between the chat and the right panel, in that order, in the same row.
    const row = host.querySelector('.ck-pane-row')!;
    const kids = [...row.children];
    const iBody = kids.indexOf(body);
    const iSide = kids.indexOf(side()!);
    const iRail = kids.indexOf(host.querySelector('[data-testid="session-rail"]')!);
    expect(iBody).toBeGreaterThanOrEqual(0);
    expect(iSide).toBeGreaterThan(iBody);
    expect(iRail).toBeGreaterThan(iSide);

    // It has a handle to resize it and a width.
    expect(row.querySelector('.ck-resize--artside')).not.toBeNull();
    expect(Number.parseInt(side()!.style.width, 10)).toBeGreaterThanOrEqual(320);
  });

  it('full width lies over the row and leaves the chat mounted and in the page; Back to chat gives the column back; Close removes it', async () => {
    await act(async () => root.render(<PaneView c={cockpit()} paneId="p" />));
    await flush();
    const term = host.querySelector('[data-testid="term"]')!;
    await act(async () => void openArtifactBeside('plan', 'p', 'Launch plan'));
    await flush();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="artifact-full"]')!.click());
    expect(side()?.getAttribute('data-full')).toBe('true');
    expect(host.querySelector('.ck-resize--artside')).toBeNull();
    expect(host.querySelector('[data-testid="term"]')).toBe(term);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="artifact-full"]')?.textContent).toBe('Back to chat');
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="artifact-full"]')!.click());
    expect(side()?.getAttribute('data-full')).toBeNull();
    expect(host.querySelector('.ck-resize--artside')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="artifact-close"]')!.click());
    expect(side()).toBeNull();
    expect(host.querySelector('[data-testid="term"]')).toBe(term);
  });

  it('the right panel can call openArtifactBeside(id) with no pane: it opens beside the chat on screen', async () => {
    expect(openArtifactBeside('plan')).toBe(false);
    await act(async () => root.render(<PaneView c={cockpit()} paneId="p" />));
    await flush();
    let opened = false;
    await act(async () => void (opened = openArtifactBeside('plan')));
    await flush();
    expect(opened).toBe(true);
    expect(side()).not.toBeNull();
    expect(invoke).toHaveBeenCalledWith('artifacts_read', { paneId: 'p', id: 'plan', version: undefined });
    // Another page replaces the first one in the same column.
    await act(async () => void openArtifactBeside('other', 'p'));
    await flush();
    expect(host.querySelectorAll('[data-testid="artifact-side"]')).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith('artifacts_read', { paneId: 'p', id: 'other', version: undefined });
    act(() => closeArtifactBeside('p'));
  });

  it('Open in a window asks the PC for a window of its own and lets go of the column', async () => {
    await act(async () => root.render(<PaneView c={cockpit()} paneId="p" />));
    await flush();
    await act(async () => void openArtifactBeside('plan', 'p', 'Launch plan'));
    await flush();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="artifact-popout"]')!.click());
    await flush();
    expect(invoke).toHaveBeenCalledWith('artifacts_pop_out', { paneId: 'p', id: 'plan', title: 'Launch plan' });
    expect(side()).toBeNull();
  });
});
