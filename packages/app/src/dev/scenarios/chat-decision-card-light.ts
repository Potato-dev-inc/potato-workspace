import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { Preview } from '../chat-decision-card-preview';
import type { HarnessScenario } from '../types';

// The chat's decision card, the quiet permission lines, a folded thought and the row under a reply.
const s: HarnessScenario = {
  name: 'chat-decision-card-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 900, height: 1000 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(Preview));
    await dom.sleep(300);
  },
};
export default s;
