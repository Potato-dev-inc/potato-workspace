import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { CrewChipPreview } from '../crew-chip-preview';
import type { HarnessScenario } from '../types';

// The crew chip with its list open (twelve agents, light), see crew-chip-preview.tsx.
const s: HarnessScenario = {
  name: 'crew-chip-twelve-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 640, height: 640 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.prepend(host);
    createRoot(host).render(createElement(CrewChipPreview, { set: 'twelve' }));
    await dom.sleep(500);
    await dom.sleep(500);
  },
};
export default s;
