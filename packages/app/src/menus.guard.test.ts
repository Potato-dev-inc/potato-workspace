// @vitest-environment node
// App-wide guard: a pop-up menu is the shared Menu (components/common/Floating). A .tsx file outside that block may not
// draw its own `role="menu"` list, so every menu gets the same placement, dismissal and Up/Down/Escape. The allow-list
// names the few menus that stay where they are, and says why. A selector such as `[role="menu"]` is not a menu and is fine.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = path.dirname(fileURLToPath(import.meta.url));
const SHARED = 'components/common/Floating.tsx';
const JSX_MENU = /\srole="menu"/;

/** Menus that are not moved, and why. Keys are paths under src/. */
const ALLOW: Record<string, string> = {
  'components/mobile/MessageActions.tsx':
    'The menu is the body of a bottom Sheet (title, the text, then the actions). A floating menu would sit over the sheet, and an outside press would close the sheet with it.',
  'components/pet/PetMenu.tsx':
    'Lives inside the pet window, which is sized to the pet. A top-layer menu would need room outside that window, and the pet window cannot be moved by the layer.',
  'components/askbar/AskBar.tsx':
    'The ask bar is its own small window, resized by api.resize(menuOpen) to fit its content. A top-layer menu would be drawn outside that window.',
  'components/cockpit/newagent/HomeCards.tsx':
    'The "add a card" list opens inline in the page, under its row, with a Close row. It is an expanding list, not a pop-up, so it is not floated.',
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return name.endsWith('.tsx') && !/\.test\./.test(name) ? [full] : [];
  });
}

const rel = (file: string) => path.relative(src, file).split(path.sep).join('/');

describe('pop-up menus use the shared Menu', () => {
  const files = sources(src).filter((f) => rel(f) !== SHARED);
  const hand = files.filter((f) => JSX_MENU.test(readFileSync(f, 'utf8'))).map(rel);

  it('no .tsx outside the shared block draws its own role="menu" (unless allow-listed)', () => {
    expect(hand.filter((f) => !(f in ALLOW))).toEqual([]);
  });

  it('every allow-list entry is still a hand-made menu (remove it once it moves)', () => {
    expect(Object.keys(ALLOW).filter((f) => !hand.includes(f))).toEqual([]);
  });

  it('every allow-list entry says why', () => {
    for (const [file, why] of Object.entries(ALLOW)) expect(why.length, file).toBeGreaterThan(40);
  });
});
