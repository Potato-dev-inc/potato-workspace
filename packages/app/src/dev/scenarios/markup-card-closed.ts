import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { MarkupCardPreview } from '../markup-card-preview';
import type { HarnessScenario } from '../types';

// The "Marked up" card, closed: see markup-card-preview.tsx.
const s: HarnessScenario = {
  name: 'markup-card-closed',
  route: 'cockpit',
  window: { width: 900, height: 700 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(MarkupCardPreview, { open: false }));
    await dom.sleep(1200);
  },
};
export default s;
