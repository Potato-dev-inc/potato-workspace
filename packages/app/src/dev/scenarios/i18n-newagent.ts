import type { HarnessScenario } from '../types';
import { PANE_CLAUDE } from '../fixtures';

// The New agent page, opened without looking for English words, so it also works with `roam.mjs --lang zh-TW`.
const s: HarnessScenario = {
  name: 'i18n-newagent',
  route: 'cockpit',
  select: PANE_CLAUDE,
  after: async (dom) => {
    await dom.click('[data-testid="side-new-agent"]');
    await dom.waitFor('[data-testid="na-ask"]');
    await dom.sleep(500);
  },
};
export default s;
