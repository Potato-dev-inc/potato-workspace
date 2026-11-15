import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { MovedPreview } from '../chat-move-preview';
import type { HarnessScenario } from '../types';

// "Move to…": moved (light), see chat-move-preview.tsx.
const s: HarnessScenario = {
  name: 'chat-move-moved-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 900, height: 700 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(MovedPreview));
    await dom.sleep(900);
  },
};
export default s;
