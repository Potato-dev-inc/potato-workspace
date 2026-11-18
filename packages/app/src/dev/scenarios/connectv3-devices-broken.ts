import { MAC_MINI } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// Connect v3 (three tabs), broken: one sentence and Fix it on This PC, the phone and PCs wait.
const s: HarnessScenario = {
  name: 'connectv3-devices-broken',
  route: 'cockpit',
  theme: 'dark',
  tunnel: 'stable-failed',
  phones: 'basic',
  devices: { devices: [MAC_MINI] },
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.waitFor('[data-testid="connect-relay-fix"]');
    await dom.sleep(900);
    document.querySelectorAll<HTMLElement>('body *').forEach((el) => {
      if (el.children.length === 0 && /^An agent took/.test(el.textContent ?? '')) ((el.closest('[role]') ?? el) as HTMLElement).style.display = 'none';
    });
  },
};
export default s;
