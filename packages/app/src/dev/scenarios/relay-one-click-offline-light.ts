import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { Preview } from '../relay-setup-preview';
import type { HarnessScenario } from '../types';

// One-button relay setup, state "offline" (light).
const s: HarnessScenario = {
  name: 'relay-one-click-offline-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 900, height: 760 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(Preview, { mode: 'offline' }));
    await dom.sleep(900);
  },
};
export default s;
