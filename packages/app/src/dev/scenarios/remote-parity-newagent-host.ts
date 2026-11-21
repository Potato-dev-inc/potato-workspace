import { MAC_MINI, MAC_PANES, NODE_MAC, WORK_LAPTOP } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// P2.1: the New agent page of a PC that has only Codex and OpenCode installed, read through that PC's host. Its agent list is that PC's
// own registry: Codex and OpenCode ready, the others listed with the same "not installed" note as on this PC.
const s: HarnessScenario = {
  name: 'remote-parity-newagent-host',
  route: 'cockpit',
  window: { width: 1280, height: 800 },
  devices: {
    devices: [{ ...MAC_MINI, level: 'full' }, WORK_LAPTOP],
    panes: { [NODE_MAC]: MAC_PANES },
    projectsOf: { [NODE_MAC]: [{ id: 'p-bill', name: 'billing-service', state: 'repo' }, { id: 'p-mob', name: 'mobile-app', state: 'folder' }] },
    agentsOf: {
      [NODE_MAC]: [
        { id: 'claude', label: 'Claude', installed: false },
        { id: 'codex', label: 'Codex' },
        { id: 'opencode', label: 'OpenCode' },
      ],
    },
  },
  after: async (dom) => {
    await dom.sleep(700);
    await dom.click('button[aria-label="Quick start menu"], button[aria-label="快速開始選單"]');
    await dom.waitFor('[data-testid="where-pill"]');
    await dom.click('[data-testid="where-pill"]');
    await dom.waitFor('.dev-where-menu');
    await dom.click(`[data-testid="where-${NODE_MAC}"]`);
    await dom.waitFor('[data-testid="na-on-device"]');
    await dom.waitFor('[data-testid="na-agent"]');
    await dom.sleep(600);
    // Open the agent list: this is what the proof looks at.
    await dom.click('[data-testid="na-agent"]');
    await dom.sleep(500);
  },
};
export default s;
