// Shared steps for the companion evidence scenarios (speak first bubble, Potato dropped on an agent, Less motion).
import { setComfort } from '../lib/comfort/store';
import { setSpeak } from '../lib/companionSpeak';
import { registerPaneTurns } from '../lib/potatoCheck';
import type { ChatTurn } from '../lib/sessionChatModel';
import type { HarnessDom } from './types';
import { PANE_CLAUDE } from './fixtures';

const fire = (target: EventTarget, type: string, x: number, y: number) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));

/** Speak-first is on and the waiting agent has waited about 12 minutes (the clock is moved forward; the rules look again at once). */
export const speakBubble = async (dom: HarnessDom) => {
  await dom.sleep(800);
  const real = Date.now.bind(Date);
  Date.now = () => real() + 12 * 60_000;
  setSpeak({ on: false, offered: true });
  await dom.sleep(100);
  setSpeak({ on: true, offered: true });
  await dom.waitFor('[data-testid="speak-bubble"]', 3000);
  await dom.sleep(400);
};

const turns = [{ id: 't1', user: { text: 'Fix the sign-in page' }, steps: [{ kind: 'text', item: { id: 'x', text: 'I am on it.' } }] }] as unknown as ChatTurn[];

/** Drag Potato from the companion row onto the waiting agent's row. */
export const potatoDrop = (finish: 'note' | 'answer') => async (dom: HarnessDom) => {
  await dom.sleep(800);
  setSpeak({ on: false, offered: true });
  localStorage.removeItem('pm.potato.checkNoted');
  registerPaneTurns(PANE_CLAUDE, () => turns);
  const face = document.querySelector('.ck-companion-face');
  const row = document.querySelector(`[data-pane-row="${PANE_CLAUDE}"]`);
  if (!face || !row) return;
  const r = row.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  fire(face, 'pointerdown', 20, 60);
  fire(window, 'pointermove', 60, 100);
  fire(window, 'pointermove', x, y);
  await dom.sleep(150);
  fire(window, 'pointermove', x + 1, y + 1);
  await dom.sleep(300);
  fire(window, 'pointerup', x + 1, y + 1);
  await dom.waitFor('[data-testid="potato-check"]', 3000);
  if (finish === 'answer') {
    // A real click starts with a press; the press ends the drag layer's "swallow the next click" after a drop.
    window.dispatchEvent(new Event('pointerdown'));
    await dom.clickText('[data-testid="potato-check"] button', 'Check');
    await dom.sleep(1200);
  }
  await dom.sleep(400);
};

/** "Less motion" is on: Potato in the sidebar uses its still frame. */
export const lessMotion = async (dom: HarnessDom) => {
  setSpeak({ on: false, offered: true });
  setComfort({ lessMotion: true });
  await dom.sleep(800);
};
