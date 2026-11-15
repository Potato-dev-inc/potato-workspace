import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { EarlierPreview, PicturePreview, SignInPreview } from '../chat-more-preview';
import type { HarnessScenario } from '../types';

// Chat: pictures, "Show earlier messages" and the sign-in without a terminal (see chat-more-preview.tsx).
const s: HarnessScenario = {
  name: 'chat-more-earlier-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 900, height: 700 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(EarlierPreview));
    await dom.sleep(800);

  },
};
export default s;
