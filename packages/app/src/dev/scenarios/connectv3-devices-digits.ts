import { MAC_MINI } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// Connect v3 (three tabs), another PC on the account wants to open this PC: the six digits are typed here.
const s: HarnessScenario = {
  name: 'connectv3-devices-digits',
  route: 'cockpit',
  theme: 'dark',
  tunnel: 'stable',
  phones: 'basic',
  devices: { devices: [MAC_MINI], pending: { id: 7, role: 'host', name: 'REN-LAPTOP', code: '', expires_at: Math.floor(Date.now() / 1000) + 300, mode: 'type', account: { first_seen: Math.floor(Date.now() / 1000) - 86400 * 30 } } },
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.waitFor('[data-testid="pair-confirm"]');
    await dom.sleep(900);
    document.querySelectorAll<HTMLElement>('body *').forEach((el) => {
      if (el.children.length === 0 && /^An agent took/.test(el.textContent ?? '')) ((el.closest('[role]') ?? el) as HTMLElement).style.display = 'none';
    });
  },
};
export default s;
