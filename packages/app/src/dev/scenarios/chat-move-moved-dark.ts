import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { MovedPreview } from '../chat-move-preview';
import type { HarnessScenario } from '../types';

// "Move to…": moved (dark), see chat-move-preview.tsx.
const s: HarnessScenario = {
  name: 'chat-move-moved-dark',
  route: 'cockpit',
  theme: 'dark',
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
