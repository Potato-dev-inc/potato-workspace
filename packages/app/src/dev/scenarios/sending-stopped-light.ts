import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { Preview } from '../sending-stopped-preview';
import type { HarnessScenario } from '../types';

// The chat's waiting list: "Sending stopped" with Try again, and an ordinary failure beside it (light).
const s: HarnessScenario = {
  name: 'sending-stopped-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 700, height: 360 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(Preview));
    await dom.sleep(300);
  },
};
export default s;
