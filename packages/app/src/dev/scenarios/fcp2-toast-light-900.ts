import type { HarnessScenario } from '../types';

// Checkpoint-2 fixes evidence: toast, light theme, 900 px wide.
const s: HarnessScenario = {
  name: 'fcp2-toast-light-900',
  route: 'settings',
  settingsTab: 'look',
  theme: 'light',
  window: { width: 900, height: 820 },
  after: async (dom) => {
    
    const setRadio = async (group: string, label: string) => {
      await dom.waitFor(`[role="radiogroup"][aria-label="${group}"]`);
      await dom.click(`[role="radiogroup"][aria-label="${group}"] [role="radio"][aria-label="${label}"]`);
      await dom.sleep(150);
    };

    await setRadio('Window layout in Individual', 'Cascade');
    await dom.waitFor('.st-toast');
    document.querySelector('.st-toast')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await dom.sleep(300);
  },
};
export default s;
