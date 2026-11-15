import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { Preview } from '../agent-rules-preview';
import type { HarnessScenario } from '../types';

// Force yes chip (off with its warning, and on), the pinned line of the New agent page, and the Rules for agents block of Settings.
const s: HarnessScenario = {
  name: 'agent-rules-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 900, height: 1100 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(Preview));
    await dom.sleep(400);
    await dom.click('[data-testid="force-yes-chip"][data-on="false"]');
    await dom.sleep(400);
  },
};
export default s;
