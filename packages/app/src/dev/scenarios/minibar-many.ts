import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { MiniBarPreview } from '../minibar-preview';
import type { HarnessScenario } from '../types';

// The Individual-mode mini bar (760 px wide) with ten agents: the chip strip scrolls, New and Back stay pinned,
// and the keyboard focus on a chip shows its close x.
const s: HarnessScenario = {
  name: 'minibar-many',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 800, height: 70 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(MiniBarPreview));
    await dom.sleep(400);
    (document.querySelector('.mb-chip') as HTMLElement | null)?.focus();
    await dom.sleep(200);
  },
};
export default s;
