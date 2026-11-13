import type { HarnessScenario } from '../types';
import { EXAMPLE_PANES, PANE_CODEX } from '../fixtures';
import { tabsDrag } from '../dndShots';

// A pane tab dragged sideways: the thin line shows where it will land (drag in progress, light, 900).
const SAME = 'C:/Users/dev/work/billing-service';
const TITLES: Record<string, string> = { 'pane-claude-1': 'fix login', 'pane-codex-1': 'tests', 'pane-opencode-1': 'docs', 'pane-pwsh-1': 'review' };
const s: HarnessScenario = {
  name: 'dnd-tabs-light-900',
  route: 'cockpit',
  theme: 'light',
  window: { width: 900, height: 760 },
  select: PANE_CODEX,
  panes: EXAMPLE_PANES.map((p) => ({ ...p, cwd: SAME, title: TITLES[p.id] ?? null })),
  after: tabsDrag,
};
export default s;
