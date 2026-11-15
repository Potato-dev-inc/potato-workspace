import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AppUpdateHost } from '../../components/updates/AppUpdateHost';
import { rememberWhatsNew } from '../../lib/update-schedule';
import type { HarnessScenario } from '../types';

// The small after-update card (bottom right), shown once after the restart into 1.1.1.
const s: HarnessScenario = {
  name: 'whatsnew-1116-card',
  route: 'cockpit',
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.sleep(300);
    rememberWhatsNew({ version: '1.1.1', notes: '- a', chats: 3 });
    const host = document.createElement('div');
    host.className = 'cockpit';
    host.setAttribute('data-theme', document.querySelector('.cockpit')?.getAttribute('data-theme') ?? 'dark');
    document.body.appendChild(host);
    const transport = { check: async () => null, busy: async () => [], install: async () => undefined, currentVersion: async () => '1.1.1' };
    createRoot(host).render(createElement(AppUpdateHost, { transport: transport as never }));
    await dom.waitFor('[data-testid="whats-new-card"]');
    await dom.sleep(600);
  },
};
export default s;
