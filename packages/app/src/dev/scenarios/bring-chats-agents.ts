import type { HarnessScenario } from '../types';

/** The empty chat list offers "Bring my chats from another agent"; pressing it lists the agents with a count each. */
const s: HarnessScenario = {
  name: 'bring-chats-agents',
  route: 'cockpit',
  theme: 'light',
  panes: [],
  bringChats: {},
  after: async (dom) => {
    await dom.waitFor('[data-testid="bring-chats-link"]');
    await dom.click('[data-testid="bring-chats-link"]');
    await dom.waitFor('.bc-agent-pick');
    await dom.sleep(500);
  },
};
export default s;
