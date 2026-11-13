import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { Preview, lookedAfterTurnTwo } from '../chat-ux-preview';
import type { HarnessScenario } from '../types';

// Round 3 chat extras (find): see chat-ux-preview.tsx.
const s: HarnessScenario = {
  name: 'chat-ux-find',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 900, height: 700 },
  after: async (dom) => {
    await dom.sleep(300);
    
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(Preview, { mode: 'find' }));
    await dom.sleep(1200);
  },
};
export default s;
