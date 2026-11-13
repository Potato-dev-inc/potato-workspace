import type { HarnessScenario } from '../types';
import { PANE_CLAUDE } from '../fixtures';

// The same page with terminals shown (today's page): the Chat | Terminal switch and every agent.
const s: HarnessScenario = {
  name: 'chatfirst-newagent-on',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1280, height: 760 },
  select: PANE_CLAUDE,
  after: async (dom) => {
    await dom.sleep(700);
    await dom.click('button.ck-side-new--primary');
    await dom.waitFor('[data-testid="na-ask"]');
    await dom.sleep(400);
    await dom.click('[data-testid="na-agent"]');
    await dom.sleep(300);
  },
};
export default s;
