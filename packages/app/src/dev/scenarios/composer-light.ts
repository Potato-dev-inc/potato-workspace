import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { Preview, COMPOSER_DRAFT_KEY, COMPOSER_DRAFT_TEXT, COMPOSER_ATTACHMENTS } from '../chat-composer-preview';
import { LS_COMPOSER_DRAFTS } from '../../lib/composerDraft';
import type { HarnessScenario } from '../types';

// The chat message box in the light theme.
const s: HarnessScenario = {
  name: 'composer-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 900, height: 620 },
  after: async (dom) => {
    await dom.sleep(300);
    try {
      const draft = { text: COMPOSER_DRAFT_TEXT, at: Date.now(), attachments: COMPOSER_ATTACHMENTS };
      localStorage.setItem(LS_COMPOSER_DRAFTS, JSON.stringify({ [COMPOSER_DRAFT_KEY]: draft }));
    } catch {
      /* no storage: the box starts empty */
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(Preview));
    await dom.sleep(300);
  },
};
export default s;
