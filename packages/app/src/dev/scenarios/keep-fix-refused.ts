import { PANE_CLAUDE } from '../fixtures';
import type { HarnessScenario } from '../types';
import { withRailData } from './right-panel-items';

// Keep all on a chat that works on a copy (refused). Run with PM_EVIDENCE_THEME=dark|light|dim.
type Invoke = (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>;
const s: HarnessScenario = {
  name: 'keep-fix-refused',
  route: 'cockpit',
  select: PANE_CLAUDE,
  window: { width: 1280, height: 860 },
  after: async (dom) => {
    withRailData(PANE_CLAUDE);
    const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__;
    if (internals) {
      const real = internals.invoke.bind(internals);
      internals.invoke = (cmd, args, opts) => (cmd === 'worktree_merge' ? Promise.reject(new Error('ORIGIN_DIRTY_OVERLAP: Your project has local edits (src/Settings.tsx)')) : real(cmd, args, opts));
    }
    dom.key(']');
    await dom.sleep(300);
    dom.key(']');
    if (!document.querySelector('[data-testid="session-rail"]')) dom.key(']');
    await dom.waitFor('[data-testid="session-rail"]');
    await dom.sleep(900);
    await dom.clickText('button', 'Keep all');
    await dom.sleep(300);
    await dom.clickText('.rp-ask-row button', 'Keep');
    await dom.sleep(600);
    document.querySelector('[data-testid="rail-changes-total"]')?.scrollIntoView({ block: 'center' });
    await dom.sleep(300);
  },
};
export default s;
