import type { HarnessScenario } from '../types';
import { EXAMPLE_PANES, PANE_CLAUDE, PANE_CODEX, PANE_OPENCODE, PANE_PWSH } from '../fixtures';

// The split view with four chats as a 2x2 grid, restored from the saved layout (dark, 1280). The left column gives
// its top chat 40% of the height; the right one is even.
const s: HarnessScenario = {
  name: 'split-grid-1280',
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
      below: { leftDown: PANE_OPENCODE, rightDown: PANE_PWSH, leftRows: 0.4, rightRows: 0.5 },
    }),
  },
};
export default s;
