import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { Preview } from '../plan-progress-preview';
import type { HarnessScenario } from '../types';

// The plan bar at the top of the chat ("3 of 6 · the current step"), the thin line in the sidebar row, two waiting messages with Edit and Remove. light.
const s: HarnessScenario = {
  name: 'plan-progress-chat-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 1280, height: 720 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(Preview));
    await dom.sleep(400);
  },
};
export default s;
