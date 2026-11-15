import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { MoveSheetPreview } from '../chat-move-preview';
import type { HarnessScenario } from '../types';

// "Move to…": sheet (light), see chat-move-preview.tsx.
const s: HarnessScenario = {
  name: 'chat-move-sheet-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 900, height: 700 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(MoveSheetPreview));
    await dom.sleep(900);
    await dom.click('[data-testid^="move-device-"] input:not([disabled])');
    await dom.sleep(600);
  },
};
export default s;
