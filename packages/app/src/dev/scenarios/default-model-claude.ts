import type { HarnessScenario } from '../types';

// Settings > Agents > Default model with the claude dropdown open: the menu floats above the card, never clipped.
const s: HarnessScenario = {
  name: 'default-model-claude',
  route: 'settings',
  settingsTab: 'agents',
  after: async (dom) => {
    await dom.waitFor('.st-adv-toggle');
    if (!document.querySelector('[data-testid="agent-model-claude"]')) await dom.click('.st-adv-toggle');
    await dom.waitFor('[data-testid="agent-model-claude"]');
    document.querySelector('[data-testid="agent-model-claude"]')?.scrollIntoView({ block: 'end' });
    await dom.sleep(300);
    await dom.click('[data-testid="agent-model-claude"]');
    await dom.waitFor('.mp-menu');
    await dom.sleep(500);
  },
};
export default s;
