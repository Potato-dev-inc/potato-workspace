import { PHONE_PANES } from '../phone-fixtures';
import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';

// The phone's new chat when the PC hides terminals: the pills are the agent and the project only (no Chat / Terminal choice).
const s: HarnessScenario = {
  name: 'chatfirst-phone-pills',
  route: 'phone',
  window: { width: 390, height: 844 },
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
        ],
        projects: [
          { id: 'p1', name: 'billing-service', state: 'repo' },
          { id: 'p2', name: 'docs-site', state: 'repo' },
        ],
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
    await dom.sleep(400);
  },
};
export default s;
