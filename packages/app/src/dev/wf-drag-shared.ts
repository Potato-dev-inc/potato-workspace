import type { HarnessDom } from './types';

/** Presses a sidebar row and moves the pointer into the right half of the window, then leaves it there (mid-drag). */
export async function dragMid(dom: HarnessDom): Promise<void> {
  const row = await dom.waitFor('[data-pane-row="sb-review"]');
  if (!row) return;
  const fire = (target: EventTarget, type: string, x: number, y: number) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  fire(row, 'pointerdown', 60, 120);
  fire(window, 'pointermove', 300, 200);
  fire(window, 'pointermove', Math.round(window.innerWidth * 0.75), 300);
  await dom.sleep(300);
}
