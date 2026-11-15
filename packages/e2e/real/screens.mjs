// How to reach each main screen of the real app: by clicking the real navigation, the way a person does. No URLs, no bridge.
import { sleep } from '../src/cdp.mjs';
import { clickText, findByText, listInteractive, mouseClick, waitForText } from './cdp-util.mjs';

const FIXED = /^(New agent|Search|Inbox|Team|Add project|Want a companion|Settings|Review|Help|More|Bring my chats|Questions from agents)/i;

/** The sidebar rows of chats and helpers (not the fixed items, not the project and group toggles). */
export async function chatRows(conn) {
  const items = await listInteractive(conn);
  return items.filter((x) => x.x < 240 && x.w > 100 && x.text && !FIXED.test(x.text) && !/^\d+ helpers?$/i.test(x.text) && !/^(a1|p1|projects?)$/i.test(x.text));
}

async function openSettings(conn) {
  const has = await conn.evalJs(`!!document.querySelector('input[aria-label="Search settings"]')`);
  if (!has) await clickText(conn, /^Settings$/, { settle: 800 });
}

const settingsPage = (name) => ({ id: `settings-${name.toLowerCase().replace(/[^a-z]+/g, '-')}`, title: `Settings: ${name}`, go: async (c) => { await openSettings(c); return clickText(c, name, { settle: 700 }); } });

export function staticScreens() {
  return [
    { id: 'inbox', title: 'Inbox', go: (c) => clickText(c, /^Inbox\b/) },
    { id: 'new-agent', title: 'New agent', go: (c) => clickText(c, /^New agent$/) },
    { id: 'team', title: 'Team', go: (c) => clickText(c, /^Team$/) },
    ...['Overview', 'Agents', 'Helpers', 'Look and feel', 'Connect', 'Keys', 'Shortcuts', 'Advanced'].map(settingsPage),
  ];
}

/** A screen per chat or helper row found in the sidebar now. */
export async function chatScreens(conn) {
  const rows = await chatRows(conn);
  return rows.slice(0, 4).map((r, n) => ({
    id: `chat-${n + 1}-${r.text.replace(/\s+(Ready|Needs you|Working|Idle)$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20)}`,
    title: `Chat or helper: ${r.text}`,
    chat: true,
    go: async (c) => { const norm = (t) => t.replace(/\s+(Ready|Needs you|Working|Idle|Done|Starting)$/i, '');
      const now = (await chatRows(c)).find((x) => norm(x.text) === norm(r.text)); if (!now) return false; await mouseClick(c, now.x, now.y); await sleep(800); return true; },
  }));
}

/** Light or dark through the app's own menu (More, bottom left). Returns the theme the cockpit reports. */
export async function setTheme(conn, mode) {
  const now = () => conn.evalJs(`document.querySelector('.cockpit')?.dataset.theme || ''`);
  if ((await now()) === mode) return mode;
  const items = await listInteractive(conn);
  const more = items.filter((x) => x.aria === 'More' && x.x < 240).sort((a, b) => b.y - a.y)[0];
  if (!more) throw new Error('the More menu is not on screen');
  await mouseClick(conn, more.x, more.y);
  await sleep(500);
  const label = mode === 'dark' ? 'Dark' : 'Light';
  const hit = await findByText(conn, new RegExp(`^${label}$`));
  if (!hit) throw new Error(`the ${label} choice is not in the More menu`);
  await mouseClick(conn, hit.x, hit.y);
  await sleep(700);
  // the menu may stay open: a click on empty page space closes it without choosing anything
  await conn.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);
  return now();
}

export { waitForText };
