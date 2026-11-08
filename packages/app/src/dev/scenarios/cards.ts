import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { Preview } from '../chat-agent-cards-preview';
import type { HarnessScenario } from '../types';

// The agent's cards: a folded tool group, an expanded terminal, a failed command, a file diff, a live activity line, the plan and a reply.
const s: HarnessScenario = {
  name: 'cards',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 900, height: 1960 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(Preview));
    await dom.sleep(300);
  },
};
export default s;
