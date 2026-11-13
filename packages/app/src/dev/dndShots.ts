// Evidence helpers for the drag scenarios (dev only): press on something, move past the 6 px threshold, move to the
// spot and STOP, so the screenshot shows the drag in progress (ghost card, insertion line, drop boxes).
import type { HarnessDom } from './types';

const pointer = (target: EventTarget, type: string, x: number, y: number) =>
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1 }));

/** Press on `from`, drag to (x, y), and leave the pointer down. */
export async function dragTo(dom: HarnessDom, from: Element, to: { x: number; y: number }): Promise<void> {
  const r = from.getBoundingClientRect();
  const sx = r.left + 12;
  const sy = r.top + r.height / 2;
  pointer(from, 'pointerdown', sx, sy);
  pointer(window, 'pointermove', sx + 20, sy + 20);
  await dom.sleep(100);
  pointer(window, 'pointermove', to.x, to.y);
  await dom.sleep(300);
}

/** Pane tabs: the first tab is dragged to just after the second one. */
export async function tabsDrag(dom: HarnessDom): Promise<void> {
  await dom.sleep(700);
  const tabs = [...document.querySelectorAll<HTMLElement>('[data-pane-tab]')];
  if (tabs.length < 3) return;
  const second = tabs[1].getBoundingClientRect();
  await dragTo(dom, tabs[0], { x: second.right - 8, y: second.top + second.height / 2 });
}

/** Sidebar: the second chat of the first project is dragged above the first one. */
export async function sidebarDrag(dom: HarnessDom): Promise<void> {
  await dom.sleep(900);
  const rows = [...document.querySelectorAll<HTMLElement>('nav [data-pane-row]')];
  if (rows.length < 2) return;
  const first = rows[0].getBoundingClientRect();
  await dragTo(dom, rows[1], { x: first.left + 40, y: first.top + 2 });
}
