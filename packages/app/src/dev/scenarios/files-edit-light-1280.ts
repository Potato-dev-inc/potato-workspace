import { PANE_CLAUDE } from '../fixtures';
import type { HarnessScenario } from '../types';

// A code file being edited in its tab: the editor with colours, line numbers and the unsaved dot (light, 1280 wide).
const s: HarnessScenario = {
  name: 'files-edit-light-1280',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'light',
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="rail-files"] [data-path="src"]');
    await dom.click('[data-testid="rail-files"] [data-path="src"]');
    await dom.waitFor('[data-testid="rail-files"] [data-path="src/auth.ts"]');
    await dom.click('[data-testid="rail-files"] [data-path="src/auth.ts"]');
    await dom.waitFor('.cm-line');
    await dom.clickText('.ck-file-head button', 'Edit');
    await dom.waitFor('[data-testid="file-edit"] .cm-line');
    await dom.sleep(400);
    const content = document.querySelector<HTMLElement>('.cm-content');
    content?.focus();
    document.execCommand('insertText', false, '// check the password length too\n');
    await dom.sleep(300);
    await dom.sleep(500);
  },
};
export default s;
