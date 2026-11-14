import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { WhatsNewPreview } from '../flow-preview';
import type { HarnessScenario } from '../types';

// The What is new card, shown once after the restart.
const s: HarnessScenario = {
  name: 'flow-whats-new',
  route: 'cockpit',
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(WhatsNewPreview));
    await dom.sleep(500);
  },
};
export default s;
