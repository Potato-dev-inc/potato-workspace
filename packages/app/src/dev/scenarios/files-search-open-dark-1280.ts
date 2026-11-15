import { PANE_CLAUDE } from '../fixtures';
import type { HarnessScenario } from '../types';

// A search hit opened: the file tab at the matching line, the line marked (dark, 1280 wide).
const s: HarnessScenario = {
  name: 'files-search-open-dark-1280',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'dark',
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="rail-files"] [data-path="src"]');
    await dom.waitFor('[data-testid="files-mode-inside"]');
    await dom.click('[data-testid="files-mode-inside"]');
    const box = (await dom.waitFor('[data-testid="files-filter"]')) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, 'user');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await dom.waitFor('[data-testid="files-content-hit"]');
    await dom.click('[data-testid="files-content-hit"]');
    await dom.waitFor('.cm-hit-line');
    await dom.sleep(900);
  },
};
export default s;
