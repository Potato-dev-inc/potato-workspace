import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { FarInstallPreview } from '../far-install-preview';
import { setLanguagePref } from '../../i18n';
import type { HarnessScenario } from '../types';

// P6.2/P6.3: the Install <agent> on <PC>? sheet, hand state (zh), over a fake far PC (see far-install-preview.tsx).
const s: HarnessScenario = {
  name: 'far-install-hand-zh',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1000, height: 760 },
  after: async (dom) => {
    setLanguagePref('zh-TW', false);
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.prepend(host);
    createRoot(host).render(createElement(FarInstallPreview, { fail: true }));
    await dom.sleep(800);
    await dom.sleep(400);
    ([...document.querySelectorAll('button')].find((b) => b.className.includes('ck-btn--primary')) as HTMLElement | undefined)?.click();
    await dom.sleep(4500);
  },
};
export default s;
