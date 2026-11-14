import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { Preview } from '../chat-copy-preview';
import type { HarnessScenario } from '../types';

// The strip under a chat that works on a copy: Keep the changes and Throw away the copy.
const s: HarnessScenario = {
  name: 'n5copy-bar-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 900, height: 360 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(Preview));
    await dom.sleep(400);
  },
};
export default s;
