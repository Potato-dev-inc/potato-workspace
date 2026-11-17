import type { HarnessScenario } from '../types';

// New agent > Where with the auto-detected sandbox "pm-sbx-main" picked: its name in the pill, a Start button that fits, a Linux folder hint.
const s: HarnessScenario = {
  name: 'phonefix-wsl-sandbox-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1280, height: 900 },
  devices: { devices: [] },
  wsl: {
    status: {
      state: 'ready',
      distros: [
        { name: 'Ubuntu', default: true, version: 2, state: 'Running' },
        { name: 'pm-sbx-main', default: false, version: 2, state: 'Running' },
      ],
    },
  },
  after: async (dom) => {
    await dom.sleep(700);
    await dom.click('button.ck-side-new--primary');
    await dom.waitFor('.ck-na-row [data-testid="where-pill"]');
    await dom.click('[data-testid="where-pill"]');
    await dom.waitFor('[data-testid="where-wsl:pm-sbx-main"]');
    await dom.sleep(300);
    await dom.click('[data-testid="where-wsl:pm-sbx-main"]');
    await dom.waitFor('[data-testid="wsl-panel"]');
    await dom.sleep(400);
  },
};
export default s;
