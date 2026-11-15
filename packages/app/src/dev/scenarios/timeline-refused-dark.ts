import type { HarnessScenario } from '../types';

// The Today page (Labs): one line for the whole day, the detail card for the newest point. timeline-refused-dark.
const s: HarnessScenario = {
  name: 'timeline-refused-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1280, height: 1000 },
  timeline: { refused: 'Undo is off for this folder: it is too big. Add big folders to .gitignore.' },
  after: async (dom) => {
    await dom.waitFor('button[aria-label="Today"]', 15000);
    await dom.click('button[aria-label="Today"]');
    await dom.waitFor('[data-testid="timeline-detail"]', 15000);
    await dom.sleep(900);
    document.querySelector<HTMLElement>('.ck-tl-card')?.scrollIntoView({ block: 'end' });
    await dom.sleep(300);
  },
};
export default s;
