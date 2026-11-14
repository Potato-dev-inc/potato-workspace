// @vitest-environment jsdom
// Screen-level: the file-by-file review is on the pane. Without a separate copy it sits in the Receipt tab (from the
// More menu); the right-panel Changes card says "1 kept · 1 left" and opens it. Put back in the pane shows the undo bar.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { HandoffControl } from '../../hooks/useHandoff';
import { resetReviewMarks } from '../../lib/turn-review';
import { currentUndo, resetUndoBar } from '../../lib/undo-bar';
import { LastTurnContext } from './away-context';
import { PaneView } from './PaneView';

const REVIEW = {
  turn: 2,
  beforeId: '3',
  afterId: '4',
  truncated: false,
  files: [
    { path: 'src/a.ts', status: 'M', added: 3, deleted: 1, binary: false, blob: 'ba' },
    { path: 'src/b.ts', status: 'A', added: 8, deleted: 0, binary: false, blob: 'bb' },
  ],
};
const TURN = {
  paneId: 'p1',
  agent: 'Claude',
  turn: 2,
  startedAtMs: 1,
  endedAtMs: 900,
  durationMs: 899,
  files: { count: 2, added: 11, deleted: 1, paths: ['src/a.ts', 'src/b.ts'] },
  approvals: [],
  end: { kind: 'idle' },
  sentence: 'Claude changed 2 files.',
};
const calls: Array<[string, unknown]> = [];
const invoke = vi.fn(async (cmd: string, args?: unknown) => {
  calls.push([cmd, args]);
  if (cmd === 'checkpoints_list') return { state: 'ok', message: '', items: [] };
  if (cmd === 'checkpoint_turn_review') return REVIEW;
  if (cmd === 'checkpoint_put_back') return { safetyId: '9', action: 'written' };
  if (cmd === 'editors_found') return [];
  if (cmd === 'pane_run_info') return { handle: 'h1', receipt: null };
  if (cmd === 'turn_summaries') return [TURN];
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

const pane = {
  status: 'idle',
  info: { id: 'p1', agent_type: 'claude', status: 'idle', pid: 1, created_at: 1, last_output_at: null, cwd: 'C:/work/shop', cols: 100, rows: 30, title: 'fix login' },
};
function cockpit(): CockpitApi {
  return {
    registry: { paneList: [pane], panes: new Map([['p1', pane]]), initialReady: true },
    names: new Map([['p1', 'Claude']]),
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
  calls.length = 0;
  resetReviewMarks();
  resetUndoBar();
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true });
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
const settle = () =>
  act(async () => {
    await new Promise((r) => setImmediate(r));
  });
const openReceipt = async () => {
  await act(async () =>
    root.render(
      <LastTurnContext.Provider value={new Map([['p1', TURN as never]])}>
        <PaneView c={cockpit()} paneId="p1" handoff={handoff} />
      </LastTurnContext.Provider>,
    ),
  );
  await settle();
  await act(async () => host.querySelector<HTMLButtonElement>('.ck-pane-head button[aria-haspopup="menu"]')!.click());
  const receipt = [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')].find((i) => i.textContent === 'Receipt')!;
  await act(async () => receipt.click());
  await settle();
};

describe('review file by file on the pane', () => {
  it('the Receipt tab holds the review: each file has Keep and Put back', async () => {
    await openReceipt();
    const review = host.querySelector('[data-testid="turn-files"]')!;
    expect(review).not.toBeNull();
    expect([...review.querySelectorAll('[data-testid="turn-file"] .ck-tf-name')].map((n) => n.textContent)).toEqual(['a.ts', 'b.ts']);
    expect(review.querySelectorAll('button[title^="Return only this file"]')).toHaveLength(2);
  });

  it('Put back on the pane asks the backend for that one file and shows the undo bar', async () => {
    await openReceipt();
    const put = host.querySelectorAll<HTMLButtonElement>('[data-testid="turn-file"] button[title^="Return only this file"]')[1];
    await act(async () => put.click());
    await settle();
    expect(calls.filter(([c]) => c === 'checkpoint_put_back')).toEqual([['checkpoint_put_back', { paneId: 'p1', beforeId: '3', path: 'src/b.ts' }]]);
    expect(currentUndo()?.text).toBe('Put back b.ts');
  });
});
