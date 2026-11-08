import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { Preview, EMPTY_DRAFT_KEY, COMPOSER_DRAFT_KEY, COMPOSER_DRAFT_TEXT } from '../chat-composer-preview';
import { LS_COMPOSER_DRAFTS } from '../../lib/composerDraft';
import type { HarnessScenario } from '../types';

// The chat message box: idle and empty (disabled send).
const s: HarnessScenario = {
  name: 'composer-idle',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 900, height: 360 },
  after: async (dom) => {
    await dom.sleep(300);
    
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(Preview, { draftKey: EMPTY_DRAFT_KEY, running: false, status: null }));
    await dom.sleep(300);
  },
};
export default s;
