// @vitest-environment node
// Every shortcut in lib/shortcuts.ts must still have its handler in the source. A grep-style check: the file
// must exist and contain the text the entry names. If a handler is renamed or removed, update the entry too.
// Below that: the registry (defaults, the person's choices, turning off, conflicts, labels per platform) and
// the "press the keys" recorder.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BINDABLE,
  DISABLED,
  SHORTCUT_GROUPS,
  SHORTCUTS,
  ariaKeyshortcuts,
  bindingFromEvent,
  bindingHint,
  bindingLabel,
  checkBinding,
  defaultBinding,
  digitForAction,
  effectiveBinding,
  formatKey,
  keyFromEvent,
  matchesAction,
  matchesBinding,
  normalizeBinding,
  parseBinding,
  recordKey,
  sanitizeKeybindings,
  setKeybindings,
  setShortcutRecording,
  shortcutKeys,
  type KeyEventLike,
} from './shortcuts';

// packages/app (this file is packages/app/src/lib).
const appRoot = fileURLToPath(new URL('../../', import.meta.url));

const ev = (extra: Partial<KeyEventLike> & { key: string }): KeyEventLike => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra });

afterEach(() => {
  setKeybindings({});
  setShortcutRecording(false);
});

describe('keyboard shortcuts list', () => {
  it.each(SHORTCUTS.flatMap((s) => s.handlers.map((h) => [s.id, h.file, h.text] as const)))(
    '%s: %s has the handler text %s',
    (_id, file, text) => {
      const path = `${appRoot}${file}`;
      expect(existsSync(path), `missing file ${file}`).toBe(true);
      expect(readFileSync(path, 'utf8')).toContain(text);
    },
  );

  it('every entry has an id, a label, keys and at least one handler', () => {
    for (const s of SHORTCUTS) {
      expect(s.label.trim(), s.id).not.toBe('');
      expect(s.keys.length, s.id).toBeGreaterThan(0);
      expect(s.handlers.length, s.id).toBeGreaterThan(0);
    }
  });

  it('ids are unique and every group is one the sheet shows', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SHORTCUTS) expect(SHORTCUT_GROUPS, s.id).toContain(s.group);
  });

  it('shows every group the sheet has at least one shortcut in', () => {
    for (const group of SHORTCUT_GROUPS) {
      expect(SHORTCUTS.some((s) => s.group === group), group).toBe(true);
    }
  });

  it('every default combo parses, on both platforms, and the first shown key is the Windows default', () => {
    for (const s of BINDABLE) {
      expect(parseBinding(s.bind!.win), `${s.id} win`).not.toBeNull();
      expect(parseBinding(s.bind!.mac), `${s.id} mac`).not.toBeNull();
      expect(s.keys[0], s.id).toBe(s.bind!.win);
    }
  });

  it('no two defaults collide on the same platform', () => {
    for (const mac of [false, true]) {
      const seen = new Map<string, string>();
      for (const s of BINDABLE.filter((b) => !b.bind!.digits)) {
        const combo = normalizeBinding(mac ? s.bind!.mac : s.bind!.win)!;
        expect(seen.get(combo), `${s.id} and ${seen.get(combo)} on ${mac ? 'Mac' : 'Windows'}`).toBeUndefined();
        seen.set(combo, s.id);
      }
    }
  });

  it('the new defaults avoid the keys terminals and readline use', () => {
    for (const id of ['pane-next', 'pane-prev', 'pane-jump', 'next-needs-me', 'open-inbox']) {
      const entry = BINDABLE.find((b) => b.id === id)!;
      for (const mac of [false, true]) {
        expect(checkBinding(id, mac ? entry.bind!.mac : entry.bind!.win, {}, mac).warnings, `${id} ${mac ? 'mac' : 'win'}`).toEqual([]);
      }
      // No bare Ctrl+letter on Windows, no Control key on a Mac.
      expect(entry.bind!.win).not.toMatch(/^(Mod|Ctrl)\+[A-Z]$/);
      expect(entry.bind!.mac).not.toMatch(/Ctrl/);
    }
  });

  it('the Mac defaults for the global shortcuts avoid Ctrl+Alt+Space (select next input source)', () => {
    for (const id of ['ask-bar', 'stop-all', 'mode-toggle']) {
      expect(effectiveBinding(id, {}, true), id).not.toBe('Ctrl+Alt+Space');
    }
    expect(formatKey(effectiveBinding('ask-bar', {}, true)!, true)).toBe('⌘⇧Space');
    expect(formatKey(effectiveBinding('ask-bar', {}, false)!, false)).toBe('Ctrl+Alt+Space');
  });
});

describe('formatKey', () => {
  it('keeps Ctrl on Windows and Linux, and calls the Meta key Win', () => {
    expect(formatKey('Mod+Shift+F', false)).toBe('Ctrl+Shift+F');
    expect(formatKey('Mod+\\', false)).toBe('Ctrl+\\');
    expect(formatKey('Ctrl+C', false)).toBe('Ctrl+C');
    expect(formatKey('Meta+Alt+Left', false)).toBe('Win+Alt+Left');
  });

  it('shows Mod as ⌘, Ctrl as ⌃, Alt as ⌥ and Shift as ⇧ on a Mac', () => {
    expect(formatKey('Mod+Shift+F', true)).toBe('⌘⇧F');
    expect(formatKey('Mod+\\', true)).toBe('⌘\\');
    expect(formatKey('Mod+Alt+Shift+P', true)).toBe('⌘⌥⇧P');
    expect(formatKey('Ctrl+C', true)).toBe('⌃C');
    expect(formatKey('Mod+Alt+Left', true)).toBe('⌘⌥←');
    expect(formatKey('Enter', true)).toBe('Enter');
  });
});

describe('parseBinding and normalizeBinding', () => {
  it('reads modifiers in any order and spelling', () => {
    expect(normalizeBinding('shift+ctrl+f')).toBe('Ctrl+Shift+F');
    expect(normalizeBinding('Cmd+Option+Left')).toBe('Meta+Alt+Left');
    expect(normalizeBinding('Mod+/')).toBe('Mod+/');
    expect(normalizeBinding('Mod++')).toBe('Mod++');
  });

  it('refuses text that is not a combo', () => {
    for (const bad of ['', 'Mod+Banana', 'A+B', 'Ctrl+Alt', 'none-of-it']) expect(parseBinding(bad), bad).toBeNull();
    expect(parseBinding('A+B')).toBeNull();
    expect(parseBinding('Ctrl+Alt')).toBeNull();
  });
});

describe('matching key presses', () => {
  it('Mod is Ctrl on Windows and Cmd on a Mac, and only that one', () => {
    expect(matchesBinding(ev({ key: 'k', ctrlKey: true }), 'Mod+K', false)).toBe(true);
    expect(matchesBinding(ev({ key: 'k', metaKey: true }), 'Mod+K', false)).toBe(false);
    expect(matchesBinding(ev({ key: 'k', metaKey: true }), 'Mod+K', true)).toBe(true);
    expect(matchesBinding(ev({ key: 'k', ctrlKey: true }), 'Mod+K', true)).toBe(false);
  });

  it('needs exactly the modifiers named', () => {
    expect(matchesBinding(ev({ key: 'F', ctrlKey: true, shiftKey: true }), 'Mod+Shift+F', false)).toBe(true);
    expect(matchesBinding(ev({ key: 'f', ctrlKey: true }), 'Mod+Shift+F', false)).toBe(false);
    expect(matchesBinding(ev({ key: 'F', ctrlKey: true, shiftKey: true, altKey: true }), 'Mod+Shift+F', false)).toBe(false);
  });

  it('a symbol ignores Shift (? is Shift+/), arrows use short names, Option letters use the key position', () => {
    expect(matchesBinding(ev({ key: '/', ctrlKey: true }), 'Mod+/', false)).toBe(true);
    expect(matchesBinding(ev({ key: '\\', ctrlKey: true }), 'Mod+\\', false)).toBe(true);
    expect(matchesBinding(ev({ key: 'ArrowLeft', ctrlKey: true, altKey: true }), 'Mod+Alt+Left', false)).toBe(true);
    expect(matchesBinding(ev({ key: '˚', code: 'KeyK', metaKey: true, altKey: true }), 'Mod+Alt+K', true)).toBe(true);
  });

  it('a shifted digit still reads as the digit', () => {
    expect(keyFromEvent(ev({ key: '!', code: 'Digit1', shiftKey: true }))).toBe('1');
  });

  it('a disabled or empty binding never matches', () => {
    expect(matchesBinding(ev({ key: 'k', ctrlKey: true }), null, false)).toBe(false);
    expect(matchesBinding(ev({ key: 'k', ctrlKey: true }), '', false)).toBe(false);
  });
});

describe('the registry with the person\'s choices', () => {
  it('starts from the default for the platform', () => {
    expect(effectiveBinding('palette', {}, false)).toBe('Mod+K');
    expect(effectiveBinding('pane-next', {}, false)).toBe('Alt+Shift+Down');
    expect(effectiveBinding('pane-next', {}, true)).toBe('Mod+Alt+Down');
    expect(effectiveBinding('not-a-shortcut', {}, false)).toBeNull();
    expect(effectiveBinding('close', {}, false)).toBeNull();
  });

  it('a choice replaces the default and the handler follows it', () => {
    setKeybindings({ palette: 'Mod+P' });
    expect(effectiveBinding('palette', undefined, false)).toBe('Mod+P');
    expect(matchesAction(ev({ key: 'p', ctrlKey: true }), 'palette', false)).toBe(true);
    expect(matchesAction(ev({ key: 'k', ctrlKey: true }), 'palette', false)).toBe(false);
  });

  it('"none" turns a shortcut off', () => {
    setKeybindings({ palette: DISABLED });
    expect(effectiveBinding('palette', undefined, false)).toBeNull();
    expect(matchesAction(ev({ key: 'k', ctrlKey: true }), 'palette', false)).toBe(false);
    expect(bindingLabel('palette', false)).toBe('');
    expect(bindingHint('palette', false)).toBe('');
    expect(shortcutKeys(BINDABLE.find((b) => b.id === 'palette')!, false)).toEqual([]);
  });

  it('keeps the fixed alternative next to a customizable key', () => {
    const entry = BINDABLE.find((b) => b.id === 'show-list')!;
    expect(shortcutKeys(entry, false)).toEqual(['Ctrl+/', '?']);
    setKeybindings({ 'show-list': DISABLED });
    expect(shortcutKeys(entry, false)).toEqual(['?']);
  });

  it('ignores choices that mean nothing', () => {
    expect(sanitizeKeybindings({ palette: 'Mod+P', nope: 'Mod+Z', split: 'garbage+', 'new-agent': 5, 'open-inbox': 'none' })).toEqual({ palette: 'Mod+P', 'open-inbox': 'none' });
    expect(sanitizeKeybindings(null)).toEqual({});
    expect(sanitizeKeybindings([1, 2])).toEqual({});
  });

  it('shows the right labels per platform, with the choices applied', () => {
    expect(bindingLabel('search-chats', false)).toBe('Ctrl+Shift+F');
    expect(bindingLabel('search-chats', true)).toBe('⌘⇧F');
    expect(bindingHint('split', false)).toBe(' (Ctrl+\\)');
    setKeybindings({ 'search-chats': 'Alt+Shift+S' });
    expect(bindingLabel('search-chats', false)).toBe('Alt+Shift+S');
    expect(bindingLabel('search-chats', true)).toBe('⌥⇧S');
  });

  it('a digits shortcut takes the modifiers and any of 1 to 9', () => {
    expect(digitForAction(ev({ key: '3', code: 'Digit3', altKey: true, shiftKey: true }), 'pane-jump', false)).toBe(3);
    expect(digitForAction(ev({ key: '#', code: 'Digit3', altKey: true, shiftKey: true }), 'pane-jump', false)).toBe(3);
    expect(digitForAction(ev({ key: '3', code: 'Digit3', altKey: true }), 'pane-jump', false)).toBeNull();
    expect(digitForAction(ev({ key: '0', code: 'Digit0', altKey: true, shiftKey: true }), 'pane-jump', false)).toBeNull();
    expect(bindingLabel('pane-jump', false)).toBe('Alt+Shift+1–9');
    expect(bindingLabel('pane-jump', true)).toBe('⌘⌥1–9');
  });

  it('no shortcut fires while keys are being recorded', () => {
    setShortcutRecording(true);
    expect(matchesAction(ev({ key: 'k', ctrlKey: true }), 'palette', false)).toBe(false);
    expect(digitForAction(ev({ key: '1', code: 'Digit1', altKey: true, shiftKey: true }), 'pane-jump', false)).toBeNull();
  });

  it('gives aria-keyshortcuts in the web names', () => {
    expect(ariaKeyshortcuts('remember', false)).toBe('Control+Shift+M');
    expect(ariaKeyshortcuts('remember', true)).toBe('Meta+Shift+M');
    expect(ariaKeyshortcuts('pane-next', false)).toBe('Alt+Shift+ArrowDown');
  });

  it('defaultBinding ignores the choices', () => {
    setKeybindings({ palette: 'Mod+P' });
    expect(defaultBinding('palette', false)).toBe('Mod+K');
  });
});

describe('checking a new combo', () => {
  it('refuses a key with no modifier (it would fire while typing)', () => {
    expect(checkBinding('palette', 'J', {}, false).error).toMatch(/Ctrl, Alt/);
    expect(checkBinding('palette', 'Shift+J', {}, false).error).toBeTruthy();
    expect(checkBinding('palette', 'F5', {}, false).error).toBeNull();
  });

  it('a digits shortcut needs a number key', () => {
    expect(checkBinding('pane-jump', 'Alt+Shift+A', {}, false).error).toMatch(/number/);
    expect(checkBinding('pane-jump', 'Alt+Shift+2', {}, false).error).toBeNull();
  });

  it('warns when another shortcut already has the keys, and names it', () => {
    const check = checkBinding('palette', 'Mod+N', {}, false);
    expect(check.error).toBeNull();
    expect(check.warnings.map((w) => w.kind)).toContain('conflict');
    expect(check.warnings[0].message).toContain('New agent');
  });

  it('sees a conflict made by the person\'s own choice, and a conflict with a digit range', () => {
    expect(checkBinding('palette', 'Mod+J', { 'new-agent': 'Mod+J' }, false).warnings.some((w) => w.kind === 'conflict')).toBe(true);
    expect(checkBinding('open-inbox', 'Alt+Shift+4', {}, false).warnings.some((w) => w.kind === 'conflict')).toBe(true);
  });

  it('a turned-off shortcut frees its keys', () => {
    expect(checkBinding('palette', 'Mod+N', { 'new-agent': DISABLED }, false).warnings).toEqual([]);
  });

  it('warns about keys terminals use, but not for a shortcut\'s own default', () => {
    const c = checkBinding('palette', 'Mod+D', {}, false);
    expect(c.warnings.map((w) => w.kind)).toEqual(['reserved']);
    for (const letter of ['C', 'Z', 'L', 'R', 'A', 'E']) {
      expect(checkBinding('palette', `Mod+${letter}`, {}, false).warnings.some((w) => w.kind === 'reserved'), letter).toBe(true);
    }
    // Ctrl+K is the palette's own default, so no warning on it.
    expect(checkBinding('palette', 'Mod+K', {}, false).warnings).toEqual([]);
  });

  it('on a Mac the terminal keys are the Control key, and Cmd+C and friends belong to macOS', () => {
    expect(checkBinding('palette', 'Ctrl+D', {}, true).warnings.some((w) => w.kind === 'reserved')).toBe(true);
    expect(checkBinding('palette', 'Mod+D', {}, true).warnings.some((w) => w.kind === 'reserved')).toBe(false);
    expect(checkBinding('palette', 'Mod+C', {}, true).warnings.some((w) => w.kind === 'reserved')).toBe(true);
  });

  it('warns about Alt+letter (terminals), the Windows key and Alt+F4', () => {
    expect(checkBinding('palette', 'Alt+B', {}, false).warnings.some((w) => w.kind === 'reserved')).toBe(true);
    expect(checkBinding('palette', 'Meta+B', {}, false).warnings.some((w) => w.kind === 'reserved')).toBe(true);
    expect(checkBinding('palette', 'Alt+F4', {}, false).warnings.some((w) => w.kind === 'reserved')).toBe(true);
  });

  it('a global shortcut needs a real modifier too', () => {
    expect(checkBinding('stop-all', 'Shift+P', {}, false).error).toBeTruthy();
    expect(checkBinding('stop-all', 'Mod+Alt+K', {}, false).error).toBeNull();
  });
});

describe('the recorder', () => {
  it('Esc alone cancels; Esc with a modifier is a combo', () => {
    expect(recordKey(ev({ key: 'Escape' }), false)).toEqual({ kind: 'cancel' });
    expect(recordKey(ev({ key: 'Escape', ctrlKey: true }), false)).toEqual({ kind: 'combo', binding: 'Mod+Esc' });
  });

  it('a lone modifier keeps waiting', () => {
    for (const key of ['Control', 'Shift', 'Alt', 'Meta']) expect(recordKey(ev({ key, ctrlKey: key === 'Control' }), false)).toEqual({ kind: 'wait' });
  });

  it('records Ctrl as Mod on Windows, and Cmd as Mod with a separate Control on a Mac', () => {
    expect(bindingFromEvent(ev({ key: 'k', ctrlKey: true }), false)).toBe('Mod+K');
    expect(bindingFromEvent(ev({ key: 'k', metaKey: true }), false)).toBe('Meta+K');
    expect(bindingFromEvent(ev({ key: 'k', metaKey: true }), true)).toBe('Mod+K');
    expect(bindingFromEvent(ev({ key: 'k', ctrlKey: true }), true)).toBe('Ctrl+K');
    expect(bindingFromEvent(ev({ key: 'k', ctrlKey: true, metaKey: true, altKey: true, shiftKey: true }), true)).toBe('Mod+Ctrl+Alt+Shift+K');
  });

  it('records arrows, function keys and symbols the way a combo is written', () => {
    expect(bindingFromEvent(ev({ key: 'ArrowDown', altKey: true, shiftKey: true }), false)).toBe('Alt+Shift+Down');
    expect(bindingFromEvent(ev({ key: 'F5', ctrlKey: true }), false)).toBe('Mod+F5');
    expect(bindingFromEvent(ev({ key: '\\', ctrlKey: true }), false)).toBe('Mod+\\');
    expect(bindingFromEvent(ev({ key: ' ', ctrlKey: true, altKey: true }), false)).toBe('Mod+Alt+Space');
  });

  it('what the recorder gives back is what the handler matches', () => {
    for (const mac of [false, true]) {
      const press = ev({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: !mac, metaKey: mac, altKey: true });
      const result = recordKey(press, mac);
      expect(result.kind).toBe('combo');
      if (result.kind === 'combo') expect(matchesBinding(press, result.binding, mac)).toBe(true);
    }
  });
});
