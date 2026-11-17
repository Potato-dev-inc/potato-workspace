import type { HarnessScenario } from '../types';

// 1.1.9 evidence: settings-tray-row.
const s: HarnessScenario = {
  name: 'settings-tray-row',
  route: 'settings',
  settingsTab: 'look',
  window: { width: 1100, height: 1000 },
  after: async (dom) => {
    await dom.waitFor('[data-row="close-to-tray"]', 6000).catch(() => null);
    const advanced = document.querySelector<HTMLElement>('.st-adv-toggle[aria-expanded="false"]');
    advanced?.click();
    await dom.sleep(200);
    await dom.waitFor('[data-row="close-to-tray"]');
    document.querySelector('[data-row="close-to-tray"]')?.scrollIntoView({ block: 'center' });
    await dom.sleep(300);
  },
};
export default s;
