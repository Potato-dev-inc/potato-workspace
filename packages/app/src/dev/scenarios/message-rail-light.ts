import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { Preview } from '../message-rail-preview';
import type { HarnessScenario } from '../types';

// The message rail beside the chat scroll bar (N5-19), light: see message-rail-preview.tsx.
const s: HarnessScenario = {
  name: 'message-rail-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 900, height: 700 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(Preview));
    await dom.sleep(1600);
  },
};
export default s;
