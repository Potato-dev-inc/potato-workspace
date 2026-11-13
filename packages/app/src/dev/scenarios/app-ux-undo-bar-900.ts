import type { HarnessScenario } from '../types';
import { PANE_CLAUDE } from '../fixtures';
import { showUndo } from '../../lib/undo-bar';
import { t } from '../../i18n';

// The undo bar after an agent was closed ("Closed Claude · Undo"), over the cockpit. The bar is raised the way the
// close path raises it (the real path is covered by hooks/useCockpit.undo.test.tsx).
const s: HarnessScenario = {
  name: 'app-ux-undo-bar-900',
  route: 'cockpit',
  select: PANE_CLAUDE,
  window: { width: 900, height: 820 },
  after: async (dom) => {
    await dom.sleep(600);
    showUndo({ text: t('undo.closed', { name: 'Billing tests' }), undo: () => {}, ms: 600_000 });
    await dom.waitFor('[data-testid="undo-bar"]');
    await dom.sleep(400);
  },
};
export default s;
