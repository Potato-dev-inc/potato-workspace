import { PANE_CLAUDE } from '../fixtures';
import { openArtifactBeside } from '../../lib/artifact-side';
import type { HarnessScenario } from '../types';

// Point and Fix on the page beside the chat: armed, dark.
const s: HarnessScenario = {
  name: 'artifacts-point-dark-1400',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'dark',
  window: { width: 1400, height: 800 },
  after: async (dom) => {
    openArtifactBeside('signin-report', PANE_CLAUDE, 'Sign-in report');
    await dom.waitFor('[data-testid="artifact-side-view"] iframe');
    await dom.sleep(900);
    await dom.click('[data-testid="artifact-point"]');
    await dom.sleep(300);
  },
};
export default s;
