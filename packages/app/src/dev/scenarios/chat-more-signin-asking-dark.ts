import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { EarlierPreview, PicturePreview, SignInPreview } from '../chat-more-preview';
import type { HarnessScenario } from '../types';

// Chat: pictures, "Show earlier messages" and the sign-in without a terminal (see chat-more-preview.tsx).
const s: HarnessScenario = {
  name: 'chat-more-signin-asking-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 900, height: 700 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(SignInPreview, { asking: true }));
    await dom.sleep(800);
    const start = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Sign in');
    start?.click();
    await dom.sleep(700);
  },
};
export default s;
