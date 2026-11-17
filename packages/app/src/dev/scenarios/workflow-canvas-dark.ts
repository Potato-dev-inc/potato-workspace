import type { HarnessScenario } from '../types';

// Workflows (Labs): the crew canvas on a workflow. The Front box, its helpers with "when to use", and the workflow block.
const s: HarnessScenario = {
  name: 'workflow-canvas-dark',
  route: 'settings',
  theme: 'dark',
  workflows: true,
  settingsTab: 'crews-page',
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    // The standalone settings window has no --bg token; the canvas takes the page's own background.
    document.documentElement.style.setProperty('--bg', getComputedStyle(document.body).backgroundColor);
    await dom.clickText('button', 'Open the canvas');
    await dom.waitFor('[data-testid="crew-box"]');
    await dom.sleep(600);
    await dom.click('[data-testid="crew-box"]');
    await dom.waitFor('[data-testid="workflow-panel"]');
    await dom.sleep(500);
  },
};
export default s;
