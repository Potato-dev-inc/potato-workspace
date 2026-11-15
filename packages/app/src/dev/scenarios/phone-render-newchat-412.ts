import { PANE_CODEX } from '../fixtures';
import { PHONE_PANES } from '../phone-fixtures';
import type { HarnessScenario } from '../types';

// The phone's New chat at 412 px: a model pill in the box, and the terminal-only agents dimmed with a tag.
const s: HarnessScenario = {
  name: 'phone-render-newchat-412',
  route: 'phone',
  window: { width: 412, height: 844 },
  phonePanes: PHONE_PANES.map((p) => ({ ...p, lane: 'acp' }) as typeof p),
  phone: {
    activeTab: PANE_CODEX,
    digest: false,
    questions: false,
    attention: { blocking: 0 },
    acp: {
      newChat: {
        agents: [
          { id: 'claude', label: 'Claude', chat: true, terminal: false },
          { id: 'codex', label: 'Codex', chat: true, terminal: false },
          { id: 'opencode', label: 'OpenCode', chat: true, terminal: false },
          { id: 'agy', label: 'Agy', chat: false, terminal: true },
          { id: 'aider', label: 'Aider', chat: false, terminal: true },
        ],
        projects: [{ id: 'p1', name: 'pm-workspace', state: 'repo' }],
        terminals: false,
        need_terminals: 3,
      },
    },
  },
  after: async (dom) => {
    await dom.waitFor('.ph-conv');
    await dom.sleep(700);
    await dom.click('header > button.ph-iconbtn:last-child');
    await dom.waitFor('.ph-nc-pills');
    await dom.waitFor('[data-testid="nc-model-pill"]');
    await dom.sleep(400);
  },
};
export default s;
