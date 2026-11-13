import type { HarnessScenario } from '../types';

// Checkpoint-2 fixes evidence: toast, dark theme, 1280 px wide.
const s: HarnessScenario = {
  name: 'fcp2-toast-dark-1280',
  route: 'settings',
  settingsTab: 'look',
  theme: 'dark',
  window: { width: 1280, height: 820 },
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
