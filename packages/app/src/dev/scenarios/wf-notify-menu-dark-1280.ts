import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';
import { withChatItems } from './pane-polish-chat-items';
import { bellMenu } from '../wf-notify-steps';

// The pane's ⋯ menu with the agent's four bell rows (Alerts: ...), dark, 1280 px wide.
const s: HarnessScenario = {
  name: 'wf-notify-menu-dark-1280',
  route: 'cockpit',
  select: PANE_CODEX,
  theme: 'dark',
  window: { width: 1280, height: 900 },
  after: async (dom) => {
    withChatItems();
    await bellMenu(dom);
  },
};
export default s;
