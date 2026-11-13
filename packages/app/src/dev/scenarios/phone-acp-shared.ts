import { PANE_CODEX } from '../fixtures';
import { PHONE_PANES } from '../phone-fixtures';
import type { HarnessScenario } from '../types';

// Shared by the phone-acp evidence scenarios (new chat, settings picker, closed chats, message actions). No default export,
// so the registry skips this file.
export type AcpShot = 'newchat' | 'picker' | 'full' | 'closed' | 'actions';

const MIN = 60_000;

const CONFIG = [
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Ask each time', description: 'Asks before it changes files or runs commands.' }, { value: 'acceptEdits', name: 'Accept edits', description: 'Edits files without asking; still asks before commands.' }, { value: 'bypassPermissions', name: 'Full access', description: 'Never asks.' }] },
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'sonnet', options: [{ value: 'opus', name: 'Opus', description: 'Slowest and most careful.' }, { value: 'sonnet', name: 'Sonnet', description: 'Fast and good for most work.' }, { value: 'haiku', name: 'Haiku', description: 'Quick for small jobs.' }] },
  { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'medium', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
];

const NEW_CHAT = {
  agents: [
    { id: 'claude', label: 'Claude', chat: true, terminal: true },
    { id: 'codex', label: 'Codex', chat: true, terminal: true },
    { id: 'opencode', label: 'OpenCode', chat: false, terminal: true },
  ],
  projects: [
    { id: 'p1', name: 'billing-service', state: 'repo' },
    { id: 'p2', name: 'docs-site', state: 'repo' },
    { id: 'p3', name: 'potato-workspace', state: 'repo' },
  ],
};

const CLOSED = [
  { id: 'old1', agent: 'claude', label: 'Claude', folder: 'billing-service', updated_ms: Date.now() - 50 * MIN, title: 'Add a retry to the invoice job' },
  { id: 'old2', agent: 'codex', label: 'Codex', folder: 'docs-site', updated_ms: Date.now() - 5 * 60 * MIN, title: 'Explain the release steps' },
  { id: 'old3', agent: 'claude', label: 'Claude', folder: 'potato-workspace', updated_ms: Date.now() - 26 * 60 * MIN, title: 'Why is the build slow?' },
];

export function phoneAcpScenario(shot: AcpShot, theme: 'dark' | 'light'): HarnessScenario {
  return {
    name: `phone-acp-${shot}-${theme}`,
    route: 'phone',
    window: { width: 390, height: 844 },
    theme,
    phonePanes: PHONE_PANES.map((p) => ({ ...p, lane: 'acp' }) as typeof p),
    phone: { activeTab: PANE_CODEX, digest: false, questions: false, attention: { blocking: 0 }, acp: { configOptions: CONFIG, newChat: NEW_CHAT, closed: CLOSED } },
    after: async (dom) => {
      await dom.waitFor('.ph-conv');
      await dom.sleep(900);
      const press = (selector: string) => document.querySelector(selector)?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 8, clientY: 8 }));
      if (shot === 'newchat') {
        await dom.click('[aria-label="New chat"]');
        await dom.waitFor('.ph-nc-pills');
        await dom.sleep(500);
      }
      if (shot === 'picker' || shot === 'full') {
        await dom.click('[data-testid="phone-pick-pill"]');
        await dom.waitFor('.ph-pick');
        if (shot === 'full') {
          const radio = Array.from(document.querySelectorAll<HTMLElement>('[role="radio"]')).find((r) => r.textContent?.includes('Full access'));
          radio?.click();
          await dom.waitFor('.ph-pick-hold');
        }
        await dom.sleep(500);
      }
      if (shot === 'closed') {
        await dom.click('.ph-head-menu');
        await dom.waitFor('.ph-drawer');
        await dom.waitFor('.ph-dclosed-toggle');
        await dom.click('.ph-dclosed-toggle');
        await dom.sleep(500);
      }
      if (shot === 'actions') {
        press('.ph-you-bubble');
        await dom.waitFor('[data-testid="phone-msg-actions"]');
        await dom.sleep(500);
      }
    },
  };
}
