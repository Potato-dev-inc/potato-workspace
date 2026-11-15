import type { HarnessScenario } from '../types';

// The What's new tour, open on its first card (the real dialog, opened through the same store the Help menu uses).
const s: HarnessScenario = {
  name: 'whatsnew-1116-tour',
  route: 'cockpit',
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    const store = await import('../../whatsnew/store');
    store.setRunningVersion('1.1.1');
    store.openTour('1.1.1');
    await dom.waitFor('[data-testid="whatsnew-tour"]');
    await dom.sleep(600);
  },
};
export default s;
