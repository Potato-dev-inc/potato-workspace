import { PERF } from '../project-budget-fixtures';
import type { HarnessScenario } from '../types';

// Settings > General: the Speed report table with slow markers and Copy for support.
const s: HarnessScenario = {
  name: 'speed-report-dark',
  route: 'settings',
  theme: 'dark',
  settingsTab: 'advanced',
  window: { width: 900, height: 2600 },
  projectBudget: { perf: PERF },
  after: async (dom) => {
    const dev = [...document.querySelectorAll('.st-row')].find((r) => r.textContent?.includes('Show developer settings'));
    (dev?.querySelector('[role="switch"]') as HTMLElement | null)?.click();
    await dom.sleep(400);
    await dom.clickText('button', 'App and files');
    await dom.waitFor('.st-speed-table');
    document.querySelector('.st-speed-table')?.scrollIntoView({ block: 'center' });
    await dom.sleep(500);
  },
};
export default s;
