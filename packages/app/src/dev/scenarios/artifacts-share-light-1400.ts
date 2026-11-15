import { PANE_CLAUDE } from '../fixtures';
import { openArtifactBeside } from '../../lib/artifact-side';
import type { HarnessScenario } from '../types';

// Share box on the page beside the chat, link made, light.
const s: HarnessScenario = {
  name: 'artifacts-share-light-1400',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'light',
  window: { width: 1400, height: 800 },
  after: async (dom) => {
    openArtifactBeside('signin-report', PANE_CLAUDE, 'Sign-in report');
    await dom.waitFor('[data-testid="artifact-side-view"] iframe');
    await dom.sleep(900);
    await dom.click('[data-testid="artifact-share-open"]');
    await dom.clickText('button', 'Make link');
    await dom.waitFor('[data-testid="artifact-share-link"]');
    await dom.sleep(300);
  },
};
export default s;
