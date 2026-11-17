import type { HarnessScenario } from '../types';
import { PANE_CLAUDE } from '../fixtures';

// 1.1.9: the model list on the New agent page sits next to its button, inside the window.
const s: HarnessScenario = {
  name: 'model-menu-place-newagent-130-light',
  route: 'cockpit',
  theme: 'light',
  select: PANE_CLAUDE,
  window: { width: 1280, height: 900 },
  after: async (dom) => {
    (window as unknown as { __chatLane?: boolean; __mixedModels?: boolean }).__chatLane = true;
    (window as unknown as { __mixedModels?: boolean }).__mixedModels = true;
    document.documentElement.style.setProperty('--ui-scale', '1.3');
    await dom.sleep(300);
    // The sidebar mounts late; ask for the New agent page until it is there, then open the model list.
    for (let i = 0; i < 30 && !document.querySelector('[data-testid="na-model"]'); i++) {
      document.querySelector<HTMLElement>('button[aria-label="New agent"]')?.click();
      await dom.sleep(400);
    }
    await dom.click('[data-testid="na-model"]');
    await dom.waitFor('.mp-menu');
    await dom.sleep(500);
  },
};
export default s;
