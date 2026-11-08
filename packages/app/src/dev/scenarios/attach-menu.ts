import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { AttachPreview } from '../attach-menu-preview';
import type { HarnessScenario } from '../types';

// The message box's "+" menu open (Add files, Add folder, Add image) above a folder chip and a file chip.
const s: HarnessScenario = {
  name: 'attach-menu',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 700, height: 420 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(AttachPreview));
    await dom.sleep(300);
    await dom.click('[data-testid="chat-composer-attach"]');
    await dom.sleep(300);
  },
};
export default s;
