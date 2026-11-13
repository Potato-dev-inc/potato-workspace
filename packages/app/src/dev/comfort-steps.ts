// Shared step for the comfort evidence scenarios: set the comfort prefs (this computer's storage), tell the
// open settings window about them, open the Advanced fold (the Comfort rows are advanced), and bring them into view.
import type { HarnessDom } from './types';

const KEY = 'potato.comfort.v1';

export const comfortLook = (prefs: { textScale?: number; strongContrast?: boolean; lessMotion?: boolean; speakResults?: boolean }) => async (dom: HarnessDom) => {
  const full = { textScale: 100, strongContrast: false, lessMotion: false, speakResults: false, ...prefs };
  localStorage.setItem(KEY, JSON.stringify(full));
  window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
  await dom.waitFor('.st-adv-toggle');
  await dom.click('.st-adv-toggle');
  await dom.waitFor('[data-row="text-size"]');
  await dom.sleep(400);
  document.querySelector('[data-row="text-size"]')?.scrollIntoView({ block: 'start' });
  await dom.sleep(400);
};
