import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { FlowCardsPreview } from '../flow-preview';
import type { HarnessScenario } from '../types';
import { setLanguagePref } from '../../i18n';

// The same cards in Traditional Chinese.
const s: HarnessScenario = {
  name: 'flow-cards-zh',
  route: 'cockpit',
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    setLanguagePref('zh-TW', false);
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(FlowCardsPreview));
    await dom.sleep(500);
  },
};
export default s;
