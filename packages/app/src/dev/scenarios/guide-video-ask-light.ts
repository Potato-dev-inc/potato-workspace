import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { GuideTab } from '../../components/guide/GuideTab';
import { PANE_CLAUDE } from '../fixtures';
import type { HarnessScenario } from '../types';

// Project guide > Make a video tour: the card (ask), light theme.
const s: HarnessScenario = {
  name: 'guide-video-ask-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 1280, height: 800 },
  guide: { video: 'ask' },
  after: async (dom) => {
    await dom.sleep(300);
    // The real Guide tab, drawn on its own so the card is the whole picture.
    const host = document.createElement('div');
    host.className = 'cockpit';
    host.style.cssText = 'position:fixed;inset:0;z-index:50;background:var(--bg);display:flex;justify-content:center;padding:40px;overflow:auto';
    const inner = document.createElement('div');
    inner.style.cssText = 'width:760px';
    host.appendChild(inner);
    document.body.appendChild(host);
    createRoot(inner).render(createElement(GuideTab, { paneId: PANE_CLAUDE, project: 'tide-notes', agentType: 'claude', agentName: 'Claude' }));
    await dom.waitFor('[data-testid="guide-video-button"]');
    await dom.click('[data-testid="guide-video-button"]');
    await dom.waitFor('[data-testid="guide-video"]');
    await dom.sleep(400);
  },
};
export default s;
