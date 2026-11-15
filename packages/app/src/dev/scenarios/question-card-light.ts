import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { Preview } from '../question-card-preview';
import type { HarnessScenario } from '../types';

// An agent question as a card with options (light).
const s: HarnessScenario = {
  name: 'question-card-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 700, height: 600 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(Preview));
    await dom.sleep(300);
  },
};
export default s;
