import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { FarInstallPreview } from '../far-install-preview';
import type { HarnessScenario } from '../types';

// P6.2/P6.3: the Install <agent> on <PC>? sheet, ask state (dark), over a fake far PC (see far-install-preview.tsx).
const s: HarnessScenario = {
  name: 'far-install-ask-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1000, height: 760 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.prepend(host);
    createRoot(host).render(createElement(FarInstallPreview, { fail: false }));
    await dom.sleep(800);
  },
};
export default s;
