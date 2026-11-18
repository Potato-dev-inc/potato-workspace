import { MAC_MINI } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// Connect v3 (three tabs), Add a PC: the link is made and copied by itself.
const s: HarnessScenario = {
  name: 'connectv3-devices-add-pc',
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
    await dom.click('[data-testid="connect-add-pc"]');
    await dom.waitFor('[data-testid="connect-pc-make-link"]');
    await dom.click('[data-testid="connect-pc-make-link"]');
    await dom.waitFor('[data-testid="connect-pc-link"]');
    await dom.sleep(900);
    document.querySelectorAll<HTMLElement>('body *').forEach((el) => {
      if (el.children.length === 0 && /^An agent took/.test(el.textContent ?? '')) ((el.closest('[role]') ?? el) as HTMLElement).style.display = 'none';
    });
  },
};
export default s;
