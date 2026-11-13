import type { HarnessScenario } from '../types';
import { PANE_CLAUDE } from '../fixtures';

// Chat first: the New agent page with "Show terminals" off. No Chat | Terminal switch; the agent list shows only agents
// that can chat and one quiet line for the rest. Works with `roam.mjs --lang zh-TW`.
const s: HarnessScenario = {
  name: 'chatfirst-newagent-off',
  route: 'cockpit',
  chatFirst: true,
  theme: 'dark',
  window: { width: 1280, height: 760 },
  select: PANE_CLAUDE,
  after: async (dom) => {
    await dom.sleep(700);
    await dom.click('button.ck-side-new--primary');
    await dom.waitFor('[data-testid="na-ask"]');
    await dom.sleep(400);
    await dom.click('[data-testid="na-agent"]');
    await dom.waitFor('[data-testid="need-terminals"]');
    await dom.sleep(300);
  },
};
export default s;
