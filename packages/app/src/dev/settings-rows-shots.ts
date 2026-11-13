// Shared steps for the Settings rows evidence scenarios (settings-rows-<what>-<theme>-<width>): the Changed dot and
// Reset, the Undo toast, the Changed filter, the Look and feel previews and the Advanced copy.
import type { HarnessDom } from './types';

const setRadio = async (dom: HarnessDom, group: string, label: string) => {
  await dom.waitFor(`[role="radiogroup"][aria-label="${group}"]`);
  await dom.click(`[role="radiogroup"][aria-label="${group}"] [role="radio"][aria-label="${label}"]`);
  await dom.sleep(150);
};

/** Two changes: the window layout is Cascade and the usage bar is off. */
const changeSome = async (dom: HarnessDom) => {
  await setRadio(dom, 'Window layout in Individual', 'Cascade');
  await dom.click('[role="switch"][aria-label="Show usage bar"]');
  await dom.sleep(150);
};

export type Shot = 'look' | 'changed' | 'toast' | 'filter' | 'bridge' | 'overview';

export const shotSteps: Record<Shot, (dom: HarnessDom) => Promise<void>> = {
  look: async (dom) => {
    await dom.waitFor('[role="radiogroup"][aria-label="Theme"]');
    await dom.sleep(300);
  },
  changed: async (dom) => {
    await changeSome(dom);
    // Reset shows on hover or focus: put keyboard focus in the changed row.
    (document.querySelector('[data-row="individual-window-layout"] .st-reset') as HTMLElement | null)?.focus();
    await dom.sleep(300);
  },
  toast: async (dom) => {
    await setRadio(dom, 'Window layout in Individual', 'Cascade');
    await dom.waitFor('.st-toast');
    // Hold the toast (the pointer is on it) so the picture is taken while it shows.
    document.querySelector('.st-toast')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await dom.sleep(300);
  },
  filter: async (dom) => {
    await changeSome(dom);
    await dom.click('.st-chip');
    await dom.sleep(300);
  },
  bridge: async (dom) => {
    await dom.waitFor('[data-row="helper-tools"]');
    document.querySelector('[data-row="helper-tools"]')?.scrollIntoView({ block: 'start' });
    await dom.sleep(400);
  },
  overview: async (dom) => {
    await dom.waitFor('.st-setupcheck-head');
    document.querySelector('.st-setupcheck-head')?.scrollIntoView({ block: 'center' });
    await dom.sleep(400);
  },
};

export const shotTab: Record<Shot, string> = { look: 'look', changed: 'look', toast: 'look', filter: 'look', bridge: 'mcp-status', overview: 'overview' };
