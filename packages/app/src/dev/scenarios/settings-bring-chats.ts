import type { HarnessScenario } from '../types';

/** Settings > Agents > Your chats: the Bring chats button opens the same panel, in the Settings window. */
const s: HarnessScenario = {
  name: 'settings-bring-chats',
  route: 'settings',
  settingsTab: 'bring-chats-agents',
  bringChats: {},
  after: async (dom) => {
    for (let i = 0; i < 6 && !document.querySelector('.bc-agent-pick'); i++) {
      await dom.clickText('button', 'Bring chats');
      await dom.waitFor('.bc-agent-pick', 3000);
    }
    await dom.sleep(500);
  },
};
export default s;
