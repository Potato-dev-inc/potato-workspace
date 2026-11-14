import type { HarnessScenario } from '../types';
import { EXAMPLE_PANES, PANE_CODEX } from '../fixtures';

// Files from Explorer hover over the chat: the veil that says "Drop to attach" (dark, 1280). The real hover comes
// from the desktop window event; here the page sets the same two attributes the composer sets.
const s: HarnessScenario = {
  name: 'chat-drop-to-attach-1280',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1280, height: 760 },
  select: PANE_CODEX,
  panes: EXAMPLE_PANES,
  after: async (dom) => {
    await dom.sleep(900);
    [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent === 'Chat')?.click();
    await dom.sleep(900);
    const chat = document.querySelector<HTMLElement>('.ck-chat');
    if (!chat) return;
    chat.dataset.fileOver = 'true';
    chat.dataset.dropLabel = 'Drop to attach';
    await dom.sleep(200);
  },
};
export default s;
