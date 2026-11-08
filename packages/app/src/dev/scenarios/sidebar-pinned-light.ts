import type { HarnessScenario } from '../types';

// The left list with two chats pinned from the row menu: they sit in their own Pinned group at the top, newest pin
// first, each with a small pin icon on the right.
const s: HarnessScenario = {
  name: 'sidebar-pinned-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 1100, height: 700 },
  after: async (dom) => {
    await dom.sleep(800);
    const pinRow = async (index: number) => {
      const rows = [...document.querySelectorAll<HTMLElement>('nav.ck-side-scroll button.ck-row:not(.ck-row--flat)')];
      rows[index]?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 200 }));
      await dom.sleep(200);
      await dom.clickText('[role="menuitem"]', 'Pin');
      await dom.sleep(200);
    };
    await pinRow(3);
    await pinRow(3);
    await dom.sleep(300);
  },
};
export default s;
