import { PANE_CLAUDE } from '../fixtures';
import { openArtifactBeside } from '../../lib/artifact-side';
import type { HarnessScenario } from '../types';

// The mark-up bar over a page beside the chat: the bar open on Select, no marks yet, light.
const s: HarnessScenario = {
  name: 'markup-bar-light-1400',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'light',
  markup: true,
  window: { width: 1400, height: 800 },
  after: async (dom) => {
    openArtifactBeside('signin-report', PANE_CLAUDE, 'Sign-in report');
    await dom.waitFor('[data-testid="artifact-side-view"] iframe');
    await dom.sleep(900);
    await dom.click('[data-testid="artifact-point"]');
    await dom.waitFor('[data-testid="markup-bar"]');
    const ink = document.querySelector('[data-testid="markup-ink"]') as SVGSVGElement;
    const r = ink.getBoundingClientRect();
    const at = (type: string, x: number, y: number) => ink.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: r.left + x, clientY: r.top + y, button: 0 }));
    const drag = (x1: number, y1: number, x2: number, y2: number) => {
      at('pointerdown', x1, y1);
      at('pointermove', (x1 + x2) / 2, (y1 + y2) / 2);
      at('pointermove', x2, y2);
      at('pointerup', x2, y2);
    };
    await dom.sleep(200);
    await dom.sleep(400);
  },
};
export default s;
