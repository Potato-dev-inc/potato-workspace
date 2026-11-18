import { MAC_MINI } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// Connect v3 (three tabs), Add a phone sheet with the giant code.
const s: HarnessScenario = {
  name: 'connectv3-devices-add-phone',
  route: 'cockpit',
  theme: 'dark',
  tunnel: 'stable',
  phones: 'basic',
  devices: { devices: [MAC_MINI] },
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.waitFor('[data-testid="connect-add-phone"]');
    await dom.click('[data-testid="connect-add-phone"]');
    await dom.waitFor('[data-testid="connect-add-phone-sheet"] canvas');
    await dom.sleep(900);
    document.querySelectorAll<HTMLElement>('body *').forEach((el) => {
      if (el.children.length === 0 && /^An agent took/.test(el.textContent ?? '')) ((el.closest('[role]') ?? el) as HTMLElement).style.display = 'none';
    });
  },
};
export default s;
