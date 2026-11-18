import type { HarnessScenario } from '../types';

// Connect v3 (three tabs), a phone's own sheet: name, one switch for starting agents (off), Remove.
const s: HarnessScenario = {
  name: 'connectv3-devices-phone-sheet',
  route: 'cockpit',
  theme: 'dark',
  tunnel: 'stable',
  phones: 'basic',
  devices: { devices: [] },
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.waitFor('[data-testid="connect-phone-list"]');
    await dom.click('[data-testid="connect-phone-list"] .cx-namebtn');
    await dom.waitFor('[data-testid="connect-phone-sheet"]');
    await dom.sleep(900);
    document.querySelectorAll<HTMLElement>('body *').forEach((el) => {
      if (el.children.length === 0 && /^An agent took/.test(el.textContent ?? '')) ((el.closest('[role]') ?? el) as HTMLElement).style.display = 'none';
    });
  },
};
export default s;
