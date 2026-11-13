import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { Preview } from '../plan-progress-preview';
import type { HarnessScenario } from '../types';

// The plan bar open (done ticked, current highlighted) and a waiting message open for edit. dark.
const s: HarnessScenario = {
  name: 'plan-progress-edit-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1280, height: 720 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(Preview));
    await dom.sleep(300);
    await dom.click('.ck-planbar-head');
    await dom.click('[data-testid="chat-pending-edit"]');
    await dom.sleep(500);
  },
};
export default s;
