import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { Preview } from '../artifacts-preview';
import type { HarnessScenario } from '../types';

// The card a page the agent made leaves in the chat (N5-20), light.
const s: HarnessScenario = {
  name: 'artifacts-card-light-900',
  route: 'cockpit',
  theme: 'light',
  window: { width: 900, height: 640 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(Preview));
    await dom.waitFor('[data-testid="artifact-card"]');
    await dom.sleep(400);
  },
};
export default s;
