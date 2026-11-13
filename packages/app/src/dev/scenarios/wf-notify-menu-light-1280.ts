import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';
import { withChatItems } from './pane-polish-chat-items';
import { bellMenu } from '../wf-notify-steps';

// The pane's ⋯ menu with the agent's four bell rows (Alerts: ...), light, 1280 px wide.
const s: HarnessScenario = {
  name: 'wf-notify-menu-light-1280',
  route: 'cockpit',
  select: PANE_CODEX,
  theme: 'light',
  window: { width: 1280, height: 900 },
  after: async (dom) => {
    withChatItems();
    await bellMenu(dom);
  },
};
export default s;
