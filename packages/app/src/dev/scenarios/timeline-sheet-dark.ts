import type { HarnessScenario } from '../types';

// The Today page (Labs): one line for the whole day, the detail card for the newest point. timeline-sheet-dark.
const s: HarnessScenario = {
  name: 'timeline-sheet-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1280, height: 1000 },
  timeline: true,
  after: async (dom) => {
    await dom.waitFor('button[aria-label="Today"]', 15000);
    await dom.click('button[aria-label="Today"]');
    await dom.waitFor('[data-testid="timeline-detail"]', 15000);
    await dom.sleep(900);
    const marks = [...document.querySelectorAll<HTMLElement>('.ck-tl-mark')].filter((m) => m.dataset.faded !== 'true' && m.dataset.shape === 'turn');
    marks[Math.floor(marks.length / 2)]?.click();
    await dom.sleep(500);
    await dom.click('[data-testid="timeline-go-back"]');
    await dom.sleep(700);
  },
};
export default s;
