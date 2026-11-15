import type { HarnessScenario } from '../types';

// The Feature guide page: every demo as its still.
const s: HarnessScenario = {
  name: 'whatsnew-1116-guide',
  route: 'cockpit',
  window: { width: 1280, height: 1100 },
  after: async (dom) => {
    const store = await import('../../whatsnew/store');
    store.setRunningVersion('1.1.1');
    store.requestGuide();
    await dom.waitFor('[data-testid="feature-guide"]');
    await dom.sleep(500);
  },
};
export default s;
