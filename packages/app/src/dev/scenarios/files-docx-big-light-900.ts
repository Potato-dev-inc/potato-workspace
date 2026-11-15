import { PANE_CLAUDE } from '../fixtures';
import { openFileTab } from '../../lib/file-tabs';
import type { HarnessScenario } from '../types';

// A 60 MB Word file full of photos, streamed from a test server (scripts/evidence/big-file-open.mjs starts it on
// port 47891). It records when the text and the first picture showed: `window.__bigMarks` (milliseconds).
const s: HarnessScenario = {
  name: 'files-docx-big-light-900',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'light',
  window: { width: 900, height: 800 },
  after: async (dom) => {
    const g = globalThis as unknown as { __pmBigFile?: unknown; __bigMarks?: Record<string, number | string> };
    g.__pmBigFile = { url: 'http://127.0.0.1:47891/big-report.docx', size: 63015514 };
    let blocking = 0;
    try {
      new PerformanceObserver((list) => list.getEntries().forEach((e) => (blocking = Math.max(blocking, e.duration)))).observe({ entryTypes: ['longtask'] });
    } catch {
      /* no long-task support */
    }
    const t0 = performance.now();
    openFileTab(PANE_CLAUDE, 'big-report.docx');
    await dom.waitFor('.ck-docx h1', 60_000);
    const text = performance.now() - t0;
    await dom.waitFor('.ck-docx img.is-loaded', 60_000);
    const picture = performance.now() - t0;
    await dom.sleep(1500);
    g.__bigMarks = { textMs: Math.round(text), firstPictureMs: Math.round(picture), longestBlockMs: Math.round(blocking), loaded: document.querySelectorAll('.ck-docx img.is-loaded').length, pictures: document.querySelectorAll('.ck-docx img[id^="pmimg-"]').length, timing: document.querySelector('.ck-docx')?.getAttribute('data-open-timing') ?? '' };
  },
};
export default s;
