// @vitest-environment jsdom
// Screen-level: a standby set to "minion" has no sidebar row; its agent's Background tasks says "1 ready" (real SessionRail).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnglish } from '../../../i18n/test-utils';
import type { StandbyHelperEntry } from '../../../lib/standbyHelpers';
import { readyMinionCount } from '../standby-rows';
import { SessionRail } from './SessionRail';
import { resetRailFoldForTests } from './railFold';
import { resetTaskViews } from '../../../lib/task-view';

vi.mock('../../../hooks/useSessionChat', () => ({ useSessionChat: () => ({ turns: [], outputs: [], plan: [] }) }));
vi.mock('./usePaneBranch', () => ({ usePaneBranch: () => 'main' }));
vi.mock('../../../lib/pane-jobs', async (orig) => ({ ...(await orig<typeof import('../../../lib/pane-jobs')>()), usePaneJobs: () => ({ p1: [] }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  window.localStorage.clear();
  resetRailFoldForTests();
  resetTaskViews();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const props = { paneId: 'p1', status: 'idle', cwd: '/work/shop', agentType: 'claude', agentName: 'Claude 1', accountLabel: null, readsChat: true, helperOf: null, helpers: [], onOpenPane: () => {} };
const mount = async (extra: Record<string, unknown> = {}) => {
  await act(async () => root.render(<SessionRail {...props} {...extra} />));
  await act(async () => {});
};

describe('Background tasks: ready minion standbys', () => {
  it('says "1 ready" for one minion standby and nothing for none', async () => {
    await mount({ readyMinions: 1 });
    expect(host.querySelector('[data-testid="rail-ready"]')?.textContent).toBe('1 ready');
    expect(host.textContent).not.toContain('Nothing running');
    await mount({ readyMinions: 0 });
    expect(host.querySelector('[data-testid="rail-ready"]')).toBeNull();
    expect(host.textContent).toContain('Nothing running');
  });

  it('counts ready minion standbys under their own agent (two types only)', () => {
    const h = (id: string, over: Partial<StandbyHelperEntry>): StandbyHelperEntry => ({
      id, name: id, agent: 'claude', model: null, project: '/work/shop', after_task: 'wait', state: 'ready', note: null, pane_id: null, home: 'p1', used_by: null, taken_over: false, open_pane: null, person_pane: null, ...over,
    });
    const panes = [{ info: { id: 'p1', cwd: '/work/shop' }, status: 'idle' }];
    const list = [h('a', { kind: 'minion' }), h('b', { kind: 'spin_off' }), h('c', { kind: 'minion', state: 'busy' }), h('d', { kind: 'minion', home: 'gone' })];
    expect(readyMinionCount(list, panes, 'p1', true)).toBe(2);
    expect(readyMinionCount(list, panes, 'p1', false)).toBe(0);
    expect(readyMinionCount(list, panes, 'p2', true)).toBe(0);
  });

  it('is handed to the rail by the chat screen and the split view', () => {
    for (const file of ['PaneView.tsx', 'SplitView.tsx']) {
      expect(readFileSync(join(__dirname, '..', file), 'utf8')).toContain('readyMinions={readyMinionCount(');
    }
  });
});
