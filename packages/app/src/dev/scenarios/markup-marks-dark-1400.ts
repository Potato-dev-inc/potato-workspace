import { PANE_CLAUDE } from '../fixtures';
import { openArtifactBeside } from '../../lib/artifact-side';
import type { HarnessScenario } from '../types';

// The mark-up bar over a page beside the chat: an ellipse, an arrow and a text note on the page, dark.
const s: HarnessScenario = {
  name: 'markup-marks-dark-1400',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'dark',
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
    await dom.click('[data-testid="markup-shape"]');
    drag(60, 90, 330, 170);
    await dom.click('[data-testid="markup-shapes"]');
    await dom.click('[data-testid="markup-shape-arrow"]');
    drag(80, 260, 250, 190);
    await dom.click('[data-testid="markup-text"]');
    at('pointerdown', 120, 300);
    await dom.sleep(100);
    const note = document.querySelector('[data-testid="markup-note"]') as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(note, 'the blank page is the biggest');
    note.dispatchEvent(new Event('input', { bubbles: true }));
    note.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await dom.sleep(200);
    await dom.click('[data-testid="markup-colour"]');
    await dom.sleep(400);
  },
};
export default s;
