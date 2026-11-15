import { PANE_CODEX } from '../fixtures';
import { PHONE_PANES } from '../phone-fixtures';
import type { HarnessScenario } from '../types';

// Share to Potato: a link and a picture shared from another phone app open "New chat with this" (nothing sent yet).
const s: HarnessScenario = {
  name: 'small112-share-dark',
  route: 'phone',
  window: { width: 390, height: 844 },
  theme: 'dark',
  phonePanes: PHONE_PANES.map((p) => ({ ...p, lane: 'acp' }) as typeof p),
  phone: {
    activeTab: PANE_CODEX,
    digest: false,
    questions: false,
    attention: { blocking: 0 },
    acp: { newChat: { agents: [{ id: 'claude', label: 'Claude', chat: true, terminal: false }, { id: 'codex', label: 'Codex', chat: true, terminal: false }], projects: [{ id: 'p1', name: 'billing-service', state: 'repo' }, { id: 'p2', name: 'docs-site', state: 'repo' }], terminals: false } },
    share: { title: 'Why the invoice job retries', text: 'This post explains the retry bug I mentioned.', url: 'https://example.com/posts/invoice-retries', picture: true },
  },
  after: async (dom) => {
    await dom.waitFor('[data-testid="phone-new-chat"]');
    await dom.waitFor('[data-testid="phone-attach-chips"]');
    // The phone's "New in" card opens once per version by itself; close it so the shot shows the share.
    for (const b of Array.from(document.querySelectorAll<HTMLElement>('button'))) if (b.textContent === 'Done') b.click();
    await dom.sleep(700);
  },
};
export default s;
// window: { width: 390, height: 844 } (the registry reads the size from this file)
