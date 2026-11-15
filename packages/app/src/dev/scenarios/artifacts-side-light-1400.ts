import { PANE_CLAUDE } from '../fixtures';
import { openArtifactBeside } from '../../lib/artifact-side';
import type { HarnessScenario } from '../types';

// A page the agent made, open BESIDE the chat (the chat stays on screen), light.
const s: HarnessScenario = {
  name: 'artifacts-side-light-1400',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'light',
  window: { width: 1400, height: 800 },
  after: async (dom) => {
    openArtifactBeside('signin-report', PANE_CLAUDE, 'Sign-in report');
    await dom.waitFor('[data-testid="artifact-side-view"] iframe');
    await dom.sleep(900);

  },
};
export default s;
