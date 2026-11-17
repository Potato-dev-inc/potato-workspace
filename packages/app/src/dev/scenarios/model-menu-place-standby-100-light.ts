import type { HarnessScenario } from '../types';
import { SIDEBAR_PANES } from '../fixtures-sidebar';
import { openNewStandby } from '../../lib/standbyHelpers';

// 1.1.9: the model list opened from inside the Add a standby card sits under or above its button, inside the window.
const s: HarnessScenario = {
  name: 'model-menu-place-standby-100-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 1280, height: 900 },
  panes: SIDEBAR_PANES,
  storage: { 'pm.sidebar.groupBy': 'status' },
  after: async (dom) => {
    (window as unknown as { __chatLane?: boolean; __mixedModels?: boolean }).__chatLane = true;
    (window as unknown as { __mixedModels?: boolean }).__mixedModels = true;
    await dom.waitFor('[data-testid="standby-row"]');
    // The card's listener mounts a moment after the sidebar: ask until it answers.
    for (let i = 0; i < 20 && !document.querySelector('[data-testid="add-helper"]'); i++) {
      openNewStandby('C:/Users/dev/work/potato-workspace', 'sb-rework', { x: 300, y: 150 });
      await dom.sleep(300);
    }
    await dom.waitFor('[data-testid="add-helper"]');
    await dom.sleep(400);
    await dom.click('[data-testid="add-helper-model"]');
    await dom.waitFor('.mp-menu');
    await dom.sleep(500);
  },
};
export default s;
