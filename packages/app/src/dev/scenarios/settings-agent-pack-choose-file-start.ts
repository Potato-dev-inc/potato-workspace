import type { HarnessScenario } from '../types';

// The review sheet before any file is chosen: a "Can't set up yet" agent with its two pickers, and Other agent.
const s: HarnessScenario = {
  name: 'settings-agent-pack-choose-file-start',
  route: 'settings',
  settingsTab: 'bridge',
  window: { width: 1100, height: 900 },
  after: async (dom) => {
    await dom.waitFor('[aria-label="Add Potato Workspace to your agents"]');
    await dom.clickText('button', 'Review and install');
    await dom.waitFor('[role="dialog"] [data-testid="pack-unsupported-row"]');
    document.querySelector('[data-testid="pack-other"]')?.scrollIntoView({ block: 'end' });
    await dom.sleep(400);
  },
};
export default s;
