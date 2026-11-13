import type { HarnessScenario } from '../types';

// The review sheet with an agent Potato Workspace cannot set up yet: both pickers, the Other agent link, and
// (after choosing a settings file) the detected format, server list and the exact entry that would be added.
const s: HarnessScenario = {
  name: 'settings-agent-pack-choose-file',
  route: 'settings',
  settingsTab: 'bridge',
  window: { width: 1100, height: 900 },
  after: async (dom) => {
    await dom.waitFor('[aria-label="Let agents ask each other for help"]');
    await dom.clickText('button', 'Review and install');
    await dom.waitFor('[role="dialog"] [data-testid="pack-unsupported-row"]');
    await dom.clickText('button', 'Choose skills folder…');
    await dom.clickText('button', 'Choose settings file…');
    await dom.waitFor('[data-testid="pack-inspection"]');
    document.querySelector('[data-testid="pack-unsupported-row"]')?.scrollIntoView({ block: 'center' });
    await dom.sleep(400);
  },
};
export default s;
