import type { HarnessScenario } from '../types';

/** A time chip pressed: the list narrows and the box says "Bring all N chats from this range" with a short sample. */
const s: HarnessScenario = {
  name: 'bring-chats-range',
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
    await dom.clickText('.bc-chip', 'Last 30 days');
    await dom.waitFor('.bc-range');
    await dom.sleep(500);
  },
};
export default s;
