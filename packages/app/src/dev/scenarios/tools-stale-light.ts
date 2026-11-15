import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { ToolsStalePreview } from '../tools-stale-preview';
import type { HarnessScenario } from '../types';

// The out-of-date tools row above a chat and in Settings > Bridge, with Reconnect.
const s: HarnessScenario = {
  name: 'tools-stale-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 760, height: 420 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(ToolsStalePreview));
    await dom.sleep(800);
  },
};
export default s;
