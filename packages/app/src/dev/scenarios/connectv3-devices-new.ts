import type { HarnessScenario } from '../types';

// Connect v3 (three tabs), brand new: This PC with the one button, the giant code in the middle, no PCs yet.
const s: HarnessScenario = {
  name: 'connectv3-devices-new',
  route: 'cockpit',
  theme: 'dark',
  tunnel: 'quick',
  phones: 'none',
  devices: { devices: [] },
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.waitFor('[data-testid="connect-phone-hero"]');
    await dom.sleep(900);
    document.querySelectorAll<HTMLElement>('body *').forEach((el) => {
      if (el.children.length === 0 && /^An agent took/.test(el.textContent ?? '')) ((el.closest('[role]') ?? el) as HTMLElement).style.display = 'none';
    });
  },
};
export default s;
