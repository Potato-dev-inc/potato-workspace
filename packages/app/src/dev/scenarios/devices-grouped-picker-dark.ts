import { MAC_MINI, NODE_MAC, WORK_LAPTOP } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// New agent: the project picker grouped by device. This PC first ("REN-DESK (this PC)"), then REN-LAPTOP with its own projects, each group
// ending with its own Add project, and the offline REN-WORK greyed with one line.
export const LAPTOP = { ...MAC_MINI, name: 'REN-LAPTOP' };
export const WORK = { ...WORK_LAPTOP, name: 'REN-WORK' };
export const LAPTOP_PROJECTS = [
  { id: 'p-bill', name: 'billing-service', state: 'repo' },
  { id: 'p-mob', name: 'mobile-app', state: 'repo' },
  { id: 'p-docs', name: 'docs-site', state: 'repo' },
];
export const LOCAL_PROJECTS = JSON.stringify([{ path: 'D:/code/pm-night' }, { path: 'D:/code/docs-site' }]);

const s: HarnessScenario = {
  name: 'devices-grouped-picker-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1280, height: 800 },
  storage: { 'pm.sidebar.projects': LOCAL_PROJECTS },
  devices: { name: 'REN-DESK', devices: [LAPTOP, WORK], projectsOf: { [NODE_MAC]: LAPTOP_PROJECTS } },
  after: async (dom) => {
    await dom.sleep(700);
    await dom.click('button.ck-side-new--primary');
    await dom.waitFor('[data-testid="na-ask"]');
    await dom.click('[data-testid="na-folder"]');
    await dom.waitFor('[data-testid="na-groups"]');
    await dom.waitFor(`[data-testid="na-group-${NODE_MAC}"] .ck-na-item`);
    await dom.sleep(400);
    // The picker is long (this PC's projects first): show the bottom of it, where the other PCs are.
    const menu = document.querySelector('.ck-na-menu');
    if (menu) menu.scrollTop = menu.scrollHeight;
    await dom.sleep(200);
  },
};
export default s;
