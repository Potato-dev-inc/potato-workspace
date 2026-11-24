// @vitest-environment jsdom
// The four chat banners (branch lineage, collision, budget, keep going) show for the chat you END on after a fast burst of chat
// changes, with the REAL call queue (lib/ipc-guard.ts) holding slow reads and cancelling the ones of a chat that was left. A
// cancelled read (AbortError) must never leave a banner hidden, loading or showing another chat's words.
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guardInvoke, leavePane, resetIpcGuard, setActivePane } from '../../lib/ipc-guard';

const inner = vi.hoisted(() => ({ delay: 20, fn: null as unknown as (cmd: string, args?: unknown) => Promise<unknown> }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: unknown, options?: unknown) => (inner.fn as (...a: unknown[]) => Promise<unknown>)(cmd, args, options) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }));

import { BranchBanner } from './BranchBanner';
import { CollisionBanner } from './CollisionBanner';
import { KeepGoingBanner } from './KeepGoingBanner';
import { BudgetChip } from '../cockpit/BudgetChip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const branchView = (pane: string) => ({ id: 'bf-0123456789ab', fromLabel: `src-${pane}`, toLabel: 'Fake B', fromPaneId: 'x', toPaneId: pane, atMs: 1, pointLabel: 'after turn 5', state: 'running', stateText: 'Running', turns: 5, briefBytes: 1, branchName: 'b', closed: null, failedFiles: 0 });
const keepView = (pane: string) => ({ id: 'kg-0123456789ab', fromLabel: `from-${pane}`, toLabel: 'Fake B', fromPaneId: 'x', toPaneId: pane, atMs: 1, state: 'running', stateText: 'Running', turns: 3, briefBytes: 1, backAtMs: null, reason: 'usage_limit' });
const collisionFor = (pane: string) => ({
  id: 'ca-0123456789ab', level: 'clash', relation: 'copies', title: 't', detail: 'd', advice: null, place: 'p', footer: 'f',
  sides: [{ paneId: pane, label: `side-${pane}`, working: true }, { paneId: 'other', label: 'fake_o', working: false }],
  files: [{ path: 'src/a.ts', text: 'Lines 1-2' }], more: 0, firstMs: 1, lastMs: 2,
});

/** The desktop: each answer comes after `inner.delay` ms; per-chat answers name the chat asked about. */
function desktop(cmd: string, args?: unknown): Promise<unknown> {
  const pane = (args as { paneId?: string } | undefined)?.paneId ?? '';
  const answer = (): unknown => {
    switch (cmd) {
      case 'branch_lineage': return { from: branchView(pane), children: [] };
      case 'keep_going_lineage': return { from: null, to: keepView(pane) };
      case 'collision_list': return [collisionFor(finalPane), collisionFor('pane-b')];
      case 'budget_for_pane': return { state: 'ok', depth: 0, is_helper: false, turns: { used: 2, own: 2, held_for_helpers: 0, limit: 10, add_step: 5 }, minutes: null, time_up_in_turn: false, helpers: [] };
      default: return null;
    }
  };
  return new Promise((resolve) => setTimeout(() => resolve(answer()), inner.delay));
}
let finalPane = '';

/** What SessionChatPanel does for the chat on screen, plus the other reads a chat makes when it opens (they fill the queue). */
function Chat({ paneId, noise = 6 }: { paneId: string; noise?: number }) {
  useLayoutEffect(() => {
    setActivePane(paneId);
    return () => leavePane(paneId);
  }, [paneId]);
  useLayoutEffect(() => {
    for (let i = 0; i < noise; i++) void (inner.fn as (c: string, a: unknown) => Promise<unknown>)('pane_messages_list', { paneId, page: i }).catch(() => undefined);
  }, [paneId, noise]);
  return (
    <div data-pane={paneId}>
      <BranchBanner paneId={paneId} />
      <KeepGoingBanner paneId={paneId} />
      <CollisionBanner paneId={paneId} />
      <BudgetChip paneId={paneId} />
    </div>
  );
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  resetIpcGuard();
  inner.delay = 20;
  inner.fn = guardInvoke(((cmd: string, args?: unknown) => desktop(cmd, args)) as never) as never;
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  resetIpcGuard();
});

const settle = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const text = () => host.textContent ?? '';

function expectAllBanners(pane: string) {
  const scope = host.querySelector(`[data-pane="${pane}"]`)!;
  expect(scope.querySelector('[data-branch-banner]')?.textContent).toContain(`src-${pane}`);
  expect(scope.querySelector('[data-keep-going]')?.textContent).toContain(`from-${pane}`);
  expect(scope.querySelector('[data-collision-banner]')?.textContent).toContain('fake_o');
  expect(scope.querySelector('[data-testid="budget-chip"]')?.textContent).toContain('2 of 10 turns');
}

describe('banners after a fast burst of chat changes (real call queue, slow desktop)', () => {
  it('one chat panel hopping through 40 chats: the banners are the last chat\'s, none is hidden or another chat\'s', async () => {
    finalPane = 'pane-final';
    for (let i = 0; i < 40; i++) await act(async () => root.render(<Chat paneId={`pane-${i}`} />));
    await act(async () => root.render(<Chat paneId="pane-final" />));
    await settle(900);
    expectAllBanners('pane-final');
    expect(text()).not.toContain('src-pane-3');
  });

  it('a chat opened beside another one cancels the first one\'s waiting reads: the first still shows its banners', async () => {
    finalPane = 'pane-a';
    await act(async () => root.render(<><Chat paneId="pane-a" noise={12} /><Chat paneId="pane-b" noise={12} /></>));
    await settle(900);
    expectAllBanners('pane-a');
    expectAllBanners('pane-b');
  });

  it('a read cancelled over and over (a busy queue) ends with the banner still waiting, not cleared by the cancel', async () => {
    finalPane = 'pane-a';
    await act(async () => root.render(<Chat paneId="pane-a" noise={14} />));
    for (let i = 0; i < 6; i++) {
      act(() => setActivePane(`flip-${i}`));
      act(() => setActivePane('pane-a'));
    }
    await settle(1200);
    expectAllBanners('pane-a');
  });
});
