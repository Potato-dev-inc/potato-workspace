import type { HarnessScenario } from '../types';

// Connect v3 (three tabs), Make it work anywhere: the setup sheet, the link name is made for you.
const s: HarnessScenario = {
  name: 'connectv3-devices-setup',
  route: 'cockpit',
  theme: 'dark',
  tunnel: 'quick',
  phones: 'basic',
  devices: { devices: [] },
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.waitFor('[data-testid="relay-set-up"]');
    await dom.click('[data-testid="relay-set-up"]');
    await dom.waitFor('[data-testid="relay-sheet"]');
    await dom.sleep(900);
    document.querySelectorAll<HTMLElement>('body *').forEach((el) => {
      if (el.children.length === 0 && /^An agent took/.test(el.textContent ?? '')) ((el.closest('[role]') ?? el) as HTMLElement).style.display = 'none';
    });
  },
};
export default s;
