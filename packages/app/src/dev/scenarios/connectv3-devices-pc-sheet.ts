import { MAC_MINI, NODE_MAC } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// Connect v3 (three tabs), a PC's own sheet: ONE switch, Can work on this PC, off.
const s: HarnessScenario = {
  name: 'connectv3-devices-pc-sheet',
  route: 'cockpit',
  theme: 'dark',
  tunnel: 'stable',
  phones: 'basic',
  devices: { devices: [MAC_MINI] },
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.waitFor('[data-testid="connect-add-pc"]');
    await dom.click(`[data-testid="connect-pc-name-${NODE_MAC}"]`);
    await dom.waitFor('[data-testid="connect-pc-sheet"]');
    await dom.sleep(900);
    document.querySelectorAll<HTMLElement>('body *').forEach((el) => {
      if (el.children.length === 0 && /^An agent took/.test(el.textContent ?? '')) ((el.closest('[role]') ?? el) as HTMLElement).style.display = 'none';
    });
  },
};
export default s;
