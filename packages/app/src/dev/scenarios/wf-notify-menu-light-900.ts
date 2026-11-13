import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';
import { withChatItems } from './pane-polish-chat-items';
import { bellMenu } from '../wf-notify-steps';

// The pane's ⋯ menu with the agent's four bell rows (Alerts: ...), light, 900 px wide.
const s: HarnessScenario = {
  name: 'wf-notify-menu-light-900',
  route: 'cockpit',
  select: PANE_CODEX,
  theme: 'light',
  window: { width: 900, height: 820 },
  after: async (dom) => {
    withChatItems();
    await bellMenu(dom);
  },
};
export default s;
