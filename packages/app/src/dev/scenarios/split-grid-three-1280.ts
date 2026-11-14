import type { HarnessScenario } from '../types';
import { EXAMPLE_PANES, PANE_CLAUDE, PANE_CODEX, PANE_OPENCODE } from '../fixtures';

// Three chats: the left chat has the whole column, the right column is split down (dark, 1280).
const s: HarnessScenario = {
  name: 'split-grid-three-1280',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1280, height: 760 },
  select: PANE_CLAUDE,
  panes: EXAMPLE_PANES,
  storage: {
    'pm.cockpit.split': JSON.stringify({
      left: PANE_CLAUDE,
      right: PANE_CODEX,
      ratio: 0.5,
      below: { leftDown: null, rightDown: PANE_OPENCODE, leftRows: 0.5, rightRows: 0.5 },
    }),
  },
};
export default s;
