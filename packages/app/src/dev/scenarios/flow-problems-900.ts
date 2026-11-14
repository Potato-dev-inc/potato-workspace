import { PANE_CLAUDE, PANE_CODEX } from '../fixtures';
import { exampleUsage } from '../usage-fixtures';
import type { HarnessScenario } from '../types';

// The Problems list: the status bar says "N problems"; the sheet lists what failed, newest first, with one way out each.
const now = Date.now();
const stopped = (id: string, agent: string, cwd: string) => ({
  id,
  agent_type: agent,
  pid: 1,
  status: 'error' as const,
  created_at: now - 5 * 60_000,
  last_output_at: now - 60_000,
  cwd,
  cols: 120,
  rows: 32,
});

const s: HarnessScenario = {
  name: 'flow-problems-900',
  route: 'cockpit',
  window: { width: 900, height: 760 },
  usage: exampleUsage(),
  panes: [stopped(PANE_CLAUDE, 'claude', 'C:/Users/dev/work/potato-workspace'), stopped(PANE_CODEX, 'codex', 'C:/Users/dev/work/billing-service')],
  after: async (dom) => {
    await dom.waitFor('[data-testid="problems-chip"]');
    await dom.click('[data-testid="problems-chip"]');
    await dom.waitFor('[data-testid="problems-sheet"]');
    await dom.sleep(300);
  },
};
export default s;
