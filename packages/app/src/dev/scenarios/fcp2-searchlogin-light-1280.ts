import type { HarnessScenario } from '../types';

// Checkpoint-2 fixes evidence: searchlogin, light theme, 1280 px wide.
const s: HarnessScenario = {
  name: 'fcp2-searchlogin-light-1280',
  route: 'settings',
  settingsTab: 'overview',
  theme: 'light',
  window: { width: 1280, height: 820 },
  after: async (dom) => {
    
    const input = (await dom.waitFor('input[aria-label="Search settings"]')) as HTMLInputElement | null;
    if (!input) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'login');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await dom.sleep(500);

  },
};
export default s;
