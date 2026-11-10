import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { AcpPaneWindow } from '../../components/acp/AcpPaneWindow';
import type { HarnessScenario } from '../types';
import { PANE_CLAUDE } from '../fixtures';

// The pop-out pane window (header, Chat | More tabs) at a narrow width with the More menu open: it must stay inside the window.
const s: HarnessScenario = {
  name: 'pane-more-menu',
  route: 'cockpit',
  window: { width: 520, height: 420 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:99999;';
    document.body.appendChild(host);
    createRoot(host).render(createElement(AcpPaneWindow, { paneId: PANE_CLAUDE }));
    await dom.sleep(500);
    await dom.clickText('button[aria-haspopup="menu"]', 'More');
    await dom.waitFor('.ck-menu[role="menu"]');
    await dom.sleep(400);
  },
};
export default s;
