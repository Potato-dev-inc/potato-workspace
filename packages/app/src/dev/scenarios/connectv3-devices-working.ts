import { MAC_MINI, WORK_LAPTOP } from '../devices-fixtures';
import { SAMPLE_PCS } from '../account-pcs-fixtures';
import type { HarnessScenario } from '../types';

// Connect v3 (three tabs), working: Works anywhere, one phone, PCs of the account and a paired PC.
const s: HarnessScenario = {
  name: 'connectv3-devices-working',
  route: 'cockpit',
  theme: 'dark',
  tunnel: 'stable',
  phones: 'basic',
  devices: { devices: [MAC_MINI, WORK_LAPTOP] },
  account: { tick: true, pcs: SAMPLE_PCS },
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.waitFor('[data-testid="account-pcs-tick"]');
    await dom.sleep(900);
    document.querySelectorAll<HTMLElement>('body *').forEach((el) => {
      if (el.children.length === 0 && /^An agent took/.test(el.textContent ?? '')) ((el.closest('[role]') ?? el) as HTMLElement).style.display = 'none';
    });
  },
};
export default s;
