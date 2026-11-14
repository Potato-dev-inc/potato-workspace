import type { HarnessScenario } from '../types';
import { setLanguagePref } from '../../i18n';

// Update ready while two agents are working: "When they finish" (the default, chosen), "Tonight", "Now". Nothing is stopped.
const s: HarnessScenario = {
  name: 'flow-update-choice-zh',
  route: 'cockpit',
  appUpdate: { version: '1.0.28', busy: { agents: ['Codex', 'OpenCode'], chats: ['Codex'], terminals: ['OpenCode'] } },
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    setLanguagePref('zh-TW', false);
    // The quiet check runs at start; ask again by pressing the update button once it shows.
    await dom.waitFor('.app-update-notice', 8000);
    await dom.click('.app-update-notice button');
    await dom.waitFor('.app-update-choice');
    await dom.sleep(400);
  },
};
export default s;
