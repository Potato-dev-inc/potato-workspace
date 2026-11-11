import type { HarnessScenario } from '../types';

/** Three chats ticked and brought; two others in the run could not be read, and the Why? fold says why. */
const s: HarnessScenario = {
  name: 'bring-chats-done',
  route: 'cockpit',
  theme: 'dark',
  panes: [],
  bringChats: { outcome: 'failed-some' },
  after: async (dom) => {
    await dom.waitFor('[data-testid="bring-chats-link"]');
    await dom.click('[data-testid="bring-chats-link"]');
    await dom.waitFor('.bc-agent-pick');
    await dom.clickText('.bc-agent-pick', 'Codex');
    await dom.waitFor('.bc-row');
    for (const n of [1, 2, 3]) await dom.click(`.bc-row:nth-child(${n}) input[type="checkbox"]`);
    await dom.clickText('button', 'Bring these (3)');
    await dom.waitFor('.bc-why', 8000);
    await dom.click('.bc-why summary');
    await dom.sleep(500);
  },
};
export default s;
