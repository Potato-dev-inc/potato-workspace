import type { HarnessScenario } from '../types';
import { EXAMPLE_PANES, PANE_CODEX } from '../fixtures';

// Evidence for the pane header, pane tabs, plain right panel and Changes list (pane-light-900).
const SAME = 'C:\\Users\\dev\\work\\billing-service';
const TITLES: Record<string, string> = { 'pane-claude-1': 'fix login', 'pane-codex-1': 'tests', 'pane-opencode-1': 'docs', 'pane-pwsh-1': 'review' };
const s: HarnessScenario = {
  name: 'ui-pane-pane-light-900',
  route: 'cockpit',
  theme: 'light',
  window: { width: 900, height: 760 },
  select: PANE_CODEX,
  panes: EXAMPLE_PANES.map((p) => ({ ...p, cwd: SAME, title: TITLES[p.id] ?? null })),
  after: async (dom) => {
    await dom.sleep(500);
    await dom.click('button[aria-label="Show session details"]');
    await dom.sleep(500);
  },
};
export default s;
