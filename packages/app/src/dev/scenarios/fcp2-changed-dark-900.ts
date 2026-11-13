import type { HarnessScenario } from '../types';

// Checkpoint-2 fixes evidence: changed, dark theme, 900 px wide.
const s: HarnessScenario = {
  name: 'fcp2-changed-dark-900',
  route: 'settings',
  settingsTab: 'look',
  theme: 'dark',
  window: { width: 900, height: 820 },
  after: async (dom) => {
    
    const setRadio = async (group: string, label: string) => {
      await dom.waitFor(`[role="radiogroup"][aria-label="${group}"]`);
      await dom.click(`[role="radiogroup"][aria-label="${group}"] [role="radio"][aria-label="${label}"]`);
      await dom.sleep(150);
    };

    await setRadio('Window layout in Individual', 'Cascade');
    await dom.click('[role="switch"][aria-label="Show usage bar"]');
    await dom.sleep(300);
    (document.querySelector('[data-row="individual-window-layout"] .st-reset') as HTMLElement | null)?.focus();
    await dom.sleep(300);
  },
};
export default s;
