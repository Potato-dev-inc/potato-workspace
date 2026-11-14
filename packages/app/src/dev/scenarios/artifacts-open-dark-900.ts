import { PANE_CLAUDE } from '../fixtures';
import { openArtifactTab } from '../../lib/artifact-tabs';
import type { HarnessScenario } from '../types';

// A page the agent made, open beside the chat (N5-20), dark, 900 wide.
const s: HarnessScenario = {
  name: 'artifacts-open-dark-900',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'dark',
  window: { width: 900, height: 800 },
  after: async (dom) => {
    openArtifactTab(PANE_CLAUDE, 'signin-report', 'Sign-in report');
    await dom.waitFor('[data-testid="artifact-tab"] iframe');
    await dom.sleep(1200);
  },
};
export default s;
