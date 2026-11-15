import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { Preview } from '../routines-preview';
import type { HarnessScenario } from '../types';

// "Then…" under a chat's result card, opened: send a message, start another agent, or tell me.
const s: HarnessScenario = {
  name: 'routines-then',
  route: 'cockpit',
  window: { width: 900, height: 420 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(Preview));
    await dom.sleep(400);
    await dom.clickText('button', 'Then…');
    await dom.waitFor('.ck-routines-then');
    await dom.sleep(400);
  },
};
export default s;
