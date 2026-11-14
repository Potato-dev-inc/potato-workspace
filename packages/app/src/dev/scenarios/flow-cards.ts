import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { FlowCardsPreview } from '../flow-preview';
import type { HarnessScenario } from '../types';

// The sign-in fix card and the shared error card, as they sit in a chat.
const s: HarnessScenario = {
  name: 'flow-cards',
  route: 'cockpit',
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(FlowCardsPreview));
    await dom.sleep(500);
  },
};
export default s;
