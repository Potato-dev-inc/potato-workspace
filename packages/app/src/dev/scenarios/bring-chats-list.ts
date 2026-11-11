import type { HarnessScenario } from '../types';

/** One agent picked: its 10 newest chats with folder, date and message count, the time chips and Show more. */
const s: HarnessScenario = {
  name: 'bring-chats-list',
  route: 'cockpit',
  theme: 'dark',
  panes: [],
  bringChats: {},
  after: async (dom) => {
    await dom.waitFor('[data-testid="bring-chats-link"]');
    await dom.click('[data-testid="bring-chats-link"]');
    await dom.waitFor('.bc-agent-pick');
    await dom.clickText('.bc-agent-pick', 'Claude');
    await dom.waitFor('.bc-row');
    await dom.sleep(500);
  },
};
export default s;
