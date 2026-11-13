// Every keyboard shortcut the desktop app has, in one registry. The sheet (components/cockpit/ShortcutsSheet.tsx),
// the palette hints, the tooltips, every in-app key handler and Settings > Shortcuts read it. Each entry names the
// source file and a piece of code that must be there (`handlers`), and lib/shortcuts.test.ts fails when one of them
// is gone, so the list cannot drift away from the code. Add a shortcut here only with a real handler.
//
// Two kinds of entry:
//   - fixed: `keys` are the alternatives (shown as separate keys). They belong to a screen (J/K in the Inbox) or to
//     the terminal (Ctrl+C), so the person cannot change them.
//   - customizable: it has `bind`, the default key for Windows/Linux and for a Mac. The person's own choice is the
//     `keybindings` setting ({ [id]: combo }, "none" = turned off), merged over the defaults here.
//
// Combos are text: `Mod+Shift+F`. `Mod` is the main modifier (Ctrl on Windows and Linux, Cmd on a Mac), `Ctrl` is
// always the Control key (shown ⌃ on a Mac), `Meta` the Windows / Cmd key, then `Alt` (⌥) and `Shift` (⇧), then one key.
// Keys: a letter or digit, a symbol, Left/Right/Up/Down, Esc, Enter, Space, Tab, F1..F12 and so on.

import { t } from '../i18n';

export type ShortcutGroup = 'Navigate' | 'Chat' | 'Panes' | 'Search';
export type ShortcutScope = 'app' | 'global';

/** The order the sheet shows the groups in. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['Navigate', 'Chat', 'Panes', 'Search'];

export interface ShortcutHandler {
  /** Path from `packages/app`. */
  file: string;
  /** Text that must appear in that file. */
  text: string;
}

export interface ShortcutBind {
  /** `app`: works while the window has focus. `global`: works from any app (registered in Rust). */
  scope: ShortcutScope;
  /** Default on Windows and Linux. */
  win: string;
  /** Default on a Mac. */
  mac: string;
  /** One binding stands for the digits 1 to 9: the person picks the modifiers, any of 1..9 follows. */
  digits?: boolean;
}

export interface ShortcutEntry {
  id: string;
  group: ShortcutGroup;
  label: string;
  keys: readonly string[];
  /** Customizable entries only: the keys that stay as they are next to the customizable one (for example `?`). */
  fixedKeys?: readonly string[];
  bind?: ShortcutBind;
  handlers: readonly ShortcutHandler[];
}

export type Keybindings = Record<string, string>;

/** The stored value that turns a shortcut off. */
export const DISABLED = 'none';

// ---------------------------------------------------------------- platform

/** True on a Mac (where Cmd is the main modifier). */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
}

// ---------------------------------------------------------------- combos

export interface ParsedBinding {
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

const NAMED_KEYS: Record<string, string> = {
  arrowleft: 'Left',
  left: 'Left',
  arrowright: 'Right',
  right: 'Right',
  arrowup: 'Up',
  up: 'Up',
  arrowdown: 'Down',
  down: 'Down',
  escape: 'Esc',
  esc: 'Esc',
  enter: 'Enter',
  return: 'Enter',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  insert: 'Insert',
};

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS', 'CapsLock', 'Dead']);

/** The key part of a combo, in its one spelling. Null when it is not a key. */
function normalizeKeyName(raw: string): string | null {
  if (raw.length === 1) return /[a-z]/i.test(raw) ? raw.toUpperCase() : raw === ' ' ? 'Space' : raw;
  const named = NAMED_KEYS[raw.toLowerCase()];
  if (named) return named;
  if (/^f([1-9]|1[0-2])$/i.test(raw)) return raw.toUpperCase();
  return null;
}

/** Reads `Mod+Shift+F`. Null when it is not a combo. */
export function parseBinding(text: string): ParsedBinding | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const parts = text.split('+').map((p) => p.trim());
  const out: ParsedBinding = { mod: false, ctrl: false, meta: false, alt: false, shift: false, key: '' };
  let key: string | null = null;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // "Mod++" is Mod and the plus key.
    if (part === '' ) {
      if (i === parts.length - 1 && key === null && i > 0) key = '+';
      else if (i === parts.length - 1 || key !== null) return null;
      continue;
    }
    switch (part.toLowerCase()) {
      case 'mod':
      case 'commandorcontrol':
        out.mod = true;
        continue;
      case 'ctrl':
      case 'control':
        out.ctrl = true;
        continue;
      case 'meta':
      case 'cmd':
      case 'command':
      case 'win':
      case 'super':
        out.meta = true;
        continue;
      case 'alt':
      case 'option':
        out.alt = true;
        continue;
      case 'shift':
        out.shift = true;
        continue;
    }
    if (key !== null) return null;
    key = normalizeKeyName(part);
    if (key === null) return null;
  }
  if (key === null) return null;
  out.key = key;
  return out;
}

/** The one spelling of a combo (modifiers in a fixed order). Null when it does not parse. */
export function normalizeBinding(text: string): string | null {
  const b = parseBinding(text);
  if (!b) return null;
  return [b.mod && 'Mod', b.ctrl && 'Ctrl', b.meta && 'Meta', b.alt && 'Alt', b.shift && 'Shift', b.key].filter(Boolean).join('+');
}

const MAC_GLYPHS: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Meta: '⌘', Alt: '⌥', Shift: '⇧' };
const MAC_ARROWS: Record<string, string> = { Left: '←', Right: '→', Up: '↑', Down: '↓' };
const WIN_NAMES: Record<string, string> = { Mod: 'Ctrl', Meta: 'Win' };

/**
 * One key as the person sees it: `Ctrl+Shift+F` on Windows and Linux, `⌘⇧F` on a Mac.
 * `Mod` is Ctrl there and ⌘ here; `Ctrl` is the Control key on both (⌃ on a Mac).
 */
export function formatKey(key: string, mac: boolean): string {
  const parts = key.split('+');
  if (mac) return parts.map((p) => MAC_GLYPHS[p] ?? MAC_ARROWS[p] ?? p).join('');
  return parts.map((p) => WIN_NAMES[p] ?? p).join('+');
}

// ---------------------------------------------------------------- key events

export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The physical key for a symbol when Option changed what it types (a Mac). */
const PUNCT_BY_CODE: Record<string, string> = {
  Backslash: '\\',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};

/** The key part of a key press, in the spelling of a combo. */
export function keyFromEvent(e: KeyEventLike): string {
  const k = e.key;
  const code = e.code ?? '';
  const m = /^(?:Key([A-Z])|Digit(\d))$/.exec(code);
  if (k.length === 1) {
    if (/[a-z0-9]/i.test(k)) return k.toUpperCase();
    if (k === ' ') return 'Space';
    // Shift or Option changed the character: the key's own position is what the person means.
    if (m && (e.altKey || e.shiftKey)) return m[1] ?? m[2];
    if (e.altKey && PUNCT_BY_CODE[code]) return PUNCT_BY_CODE[code];
    return k;
  }
  if (MODIFIER_KEYS.has(k)) return k;
  if (m && (k === 'Unidentified' || k === 'Process')) return m[1] ?? m[2];
  return normalizeKeyName(k) ?? k;
}

function wantsFlags(b: ParsedBinding, mac: boolean): { ctrl: boolean; meta: boolean } {
  return { ctrl: b.ctrl || (b.mod && !mac), meta: b.meta || (b.mod && mac) };
}

/** A key that is only typed with Shift held (`?`, `:`, `{`, `|`): Shift is part of the character, not a second modifier. */
function isSymbol(key: string): boolean {
  return key.length === 1 && '?:"<>{}|_+~!@#$%^&*()'.includes(key);
}

/** Whether this key press is `binding` on this platform. Modifiers must match exactly. */
export function matchesBinding(e: KeyEventLike, binding: string | null | undefined, mac: boolean = isMacPlatform()): boolean {
  if (!binding) return false;
  const b = parseBinding(binding);
  if (!b) return false;
  const want = wantsFlags(b, mac);
  if (e.ctrlKey !== want.ctrl || e.metaKey !== want.meta || e.altKey !== b.alt) return false;
  if (e.shiftKey !== b.shift && !(isSymbol(b.key) && !b.shift)) return false;
  return keyFromEvent(e) === b.key;
}

/** For a digits binding (`Alt+Shift+1`): the digit 1 to 9 this key press is, or null. */
export function digitFromEvent(e: KeyEventLike, binding: string | null | undefined, mac: boolean = isMacPlatform()): number | null {
  if (!binding) return null;
  const b = parseBinding(binding);
  if (!b) return null;
  const key = keyFromEvent(e);
  if (!/^[1-9]$/.test(key)) return null;
  return matchesBinding(e, normalizeBinding(binding)!.replace(/[1-9]$/, key), mac) ? Number(key) : null;
}

/** The combo a key press makes, for the "press the keys" box. Null while only modifiers are down. */
export function bindingFromEvent(e: KeyEventLike, mac: boolean = isMacPlatform()): string | null {
  const key = keyFromEvent(e);
  if (MODIFIER_KEYS.has(key)) return null;
  const symbol = isSymbol(key);
  const parts: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (mac && e.ctrlKey) parts.push('Ctrl');
  if (!mac && e.metaKey) parts.push('Meta');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && !symbol) parts.push('Shift');
  parts.push(key);
  return normalizeBinding(parts.join('+'));
}

// ---------------------------------------------------------------- the registry

function handler(file: string, text: string): ShortcutHandler {
  return { file, text };
}

const COCKPIT = 'src/CockpitApp.tsx';
const MAIN_VIEW = 'src/components/cockpit/main-view.ts';

/** A customizable entry: the default shows as its first key. */
function custom(
  base: Omit<ShortcutEntry, 'keys' | 'bind'>,
  win: string,
  mac: string,
  extra: { scope?: ShortcutScope; digits?: boolean } = {},
): ShortcutEntry {
  return { ...base, keys: [win, ...(base.fixedKeys ?? [])], bind: { scope: extra.scope ?? 'app', win, mac, digits: extra.digits } };
}

export const SHORTCUTS: readonly ShortcutEntry[] = [
  // Navigate
  custom(
    {
      id: 'show-list',
      group: 'Navigate',
      label: 'Show this list',
      fixedKeys: ['?'],
      handlers: [handler(COCKPIT, "e.key === '?'"), handler(COCKPIT, "matchesAction(e, 'show-list')")],
    },
    'Mod+/',
    'Mod+/',
  ),
  custom(
    {
      id: 'new-agent',
      group: 'Navigate',
      label: 'New agent: open the page to start one',
      handlers: [handler(COCKPIT, "matchesAction(e, 'new-agent')")],
    },
    'Mod+N',
    'Mod+N',
  ),
  custom(
    {
      id: 'open-inbox',
      group: 'Navigate',
      label: 'Open the Inbox',
      handlers: [handler(COCKPIT, "matchesAction(e, 'open-inbox')")],
    },
    'Alt+Shift+I',
    'Mod+Alt+I',
  ),
  custom(
    {
      id: 'next-needs-me',
      group: 'Navigate',
      label: 'Jump to the next agent that needs you',
      handlers: [handler(COCKPIT, "matchesAction(e, 'next-needs-me')")],
    },
    'Alt+Shift+N',
    'Mod+Alt+N',
  ),
  custom(
    {
      id: 'mode-toggle',
      group: 'Navigate',
      label: 'Switch between Orchestration and Individual, from any app',
      handlers: [handler('src-tauri/src/global_shortcuts.rs', '("mode-toggle", "Mod+Alt+M", "Mod+Alt+Shift+M")')],
    },
    'Mod+Alt+M',
    'Mod+Alt+Shift+M',
    { scope: 'global' },
  ),
  {
    id: 'close',
    group: 'Navigate',
    label: 'Close the box, sheet or menu that is open',
    keys: ['Esc'],
    handlers: [handler('src/components/cockpit/Sheet.tsx', "event.key === 'Escape'")],
  },
  {
    id: 'inbox-move',
    group: 'Navigate',
    label: 'Next or previous card in the Inbox',
    keys: ['J', 'K'],
    handlers: [handler('src/components/cockpit/inbox-keys.ts', "key === 'j'")],
  },
  {
    id: 'inbox-answer',
    group: 'Navigate',
    label: 'Answer a card in the Inbox',
    keys: ['1', '2', '3'],
    handlers: [handler('src/components/cockpit/inbox-keys.ts', '/^[1-9]$/')],
  },
  {
    id: 'inbox-open',
    group: 'Navigate',
    label: "Open a card's terminal in the Inbox",
    keys: ['O'],
    handlers: [handler('src/components/cockpit/inbox-keys.ts', "key === 'o'")],
  },
  {
    id: 'review-move',
    group: 'Navigate',
    label: 'Review: next or previous item',
    keys: ['J', 'K'],
    handlers: [handler('src/components/cockpit/review/review-keys.ts', "lower === 'j'")],
  },
  {
    id: 'review-open',
    group: 'Navigate',
    label: "Review: open an item's files and changes",
    keys: ['Enter', 'O'],
    handlers: [handler('src/components/cockpit/review/review-keys.ts', "k === 'Enter' || lower === 'o'")],
  },
  {
    id: 'review-keep',
    group: 'Navigate',
    label: 'Review: Keep the item',
    keys: ['Y'],
    handlers: [handler('src/components/cockpit/review/review-keys.ts', "y: 'keep'")],
  },
  {
    id: 'review-fix',
    group: 'Navigate',
    label: 'Review: Ask to fix',
    keys: ['F'],
    handlers: [handler('src/components/cockpit/review/review-keys.ts', "f: 'fix'")],
  },
  {
    id: 'review-throw',
    group: 'Navigate',
    label: 'Review: Throw away (you can undo for 10 seconds)',
    keys: ['X'],
    handlers: [handler('src/components/cockpit/review/review-keys.ts', "x: 'throw'")],
  },
  {
    id: 'review-undo',
    group: 'Navigate',
    label: 'Review: Undo the last throw away or Looks good',
    keys: ['Z'],
    handlers: [handler('src/components/cockpit/review/review-keys.ts', "lower === 'z'")],
  },
  {
    id: 'review-pane',
    group: 'Navigate',
    label: "Review: open the agent's pane",
    keys: ['P'],
    handlers: [handler('src/components/cockpit/review/review-keys.ts', "p: 'open'")],
  },
  {
    id: 'review-close',
    group: 'Navigate',
    label: 'Review: close the item, then the Review Desk',
    keys: ['Esc'],
    handlers: [handler('src/components/cockpit/review/review-keys.ts', "k === 'Escape'")],
  },
  {
    id: 'save-memory',
    group: 'Navigate',
    label: 'Save project memory',
    keys: ['Mod+S'],
    handlers: [handler('src/components/cockpit/ProjectMemory.tsx', "e.key.toLowerCase() === 's'")],
  },

  // Chat
  {
    id: 'send',
    group: 'Chat',
    label: 'Send your message',
    keys: ['Enter'],
    handlers: [handler('src/components/chat/ChatComposer.tsx', "event.key !== 'Enter' || event.shiftKey")],
  },
  {
    id: 'new-line',
    group: 'Chat',
    label: 'New line in your message',
    keys: ['Shift+Enter'],
    handlers: [handler('src/components/chat/ChatComposer.tsx', "event.key !== 'Enter' || event.shiftKey")],
  },
  custom(
    {
      id: 'ask-aside',
      group: 'Chat',
      label: 'Ask aside: a side question that does not write into the chat',
      handlers: [handler('src/components/chat/useSideQuestion.tsx', "matchesAction(event, 'ask-aside')")],
    },
    'Mod+;',
    'Mod+;',
  ),
  custom(
    {
      id: 'remember',
      group: 'Chat',
      label: 'Remember the selected text for all agents',
      handlers: [handler('src/components/chat/RememberSelection.tsx', "matchesAction(e, 'remember')")],
    },
    'Mod+Shift+M',
    'Mod+Shift+M',
  ),
  custom(
    {
      id: 'ask-bar',
      group: 'Chat',
      label: 'Ask bar: a quick question to an agent, from any app (turn on in Settings)',
      handlers: [
        handler('src-tauri/src/askbar/mod.rs', 'DEFAULT_SHORTCUT: &str = "Ctrl+Alt+Space"'),
        handler('src-tauri/src/global_shortcuts.rs', '("ask-bar", "Mod+Alt+Space", "Mod+Shift+Space")'),
      ],
    },
    'Mod+Alt+Space',
    'Mod+Shift+Space',
    { scope: 'global' },
  ),

  // Panes
  custom(
    {
      id: 'split',
      group: 'Panes',
      label: 'Split the view with the next pane. Again closes the split',
      handlers: [handler(MAIN_VIEW, "matchesAction(e, 'split', mac)")],
    },
    'Mod+\\',
    'Mod+\\',
  ),
  custom(
    {
      id: 'split-focus-left',
      group: 'Panes',
      label: 'In a split view: move to the left chat',
      handlers: [handler(MAIN_VIEW, "matchesAction(e, 'split-focus-left', mac)")],
    },
    'Mod+Alt+Left',
    'Mod+Alt+Left',
  ),
  custom(
    {
      id: 'split-focus-right',
      group: 'Panes',
      label: 'In a split view: move to the right chat',
      handlers: [handler(MAIN_VIEW, "matchesAction(e, 'split-focus-right', mac)")],
    },
    'Mod+Alt+Right',
    'Mod+Alt+Right',
  ),
  custom(
    {
      id: 'split-swap',
      group: 'Panes',
      label: 'In a split view: swap the two chats',
      handlers: [handler(COCKPIT, "matchesAction(e, 'split-swap'")],
    },
    'Mod+Alt+X',
    'Mod+Alt+X',
  ),
  custom(
    {
      id: 'focus-mode',
      group: 'Panes',
      label: 'Focus mode: the open chat fills the window. Press again, or Esc, to come back',
      handlers: [handler(COCKPIT, "matchesAction(e, 'focus-mode'")],
    },
    'Mod+Shift+Enter',
    'Mod+Shift+Enter',
  ),
  custom(
    {
      id: 'pane-next',
      group: 'Panes',
      label: 'Next agent in the list',
      handlers: [handler(COCKPIT, "matchesAction(e, 'pane-next')")],
    },
    'Alt+Shift+Down',
    'Mod+Alt+Down',
  ),
  custom(
    {
      id: 'pane-prev',
      group: 'Panes',
      label: 'Previous agent in the list',
      handlers: [handler(COCKPIT, "matchesAction(e, 'pane-prev')")],
    },
    'Alt+Shift+Up',
    'Mod+Alt+Up',
  ),
  custom(
    {
      id: 'pane-jump',
      group: 'Panes',
      label: 'Jump to agent number 1 to 9 in the list',
      handlers: [handler(COCKPIT, "digitForAction(e, 'pane-jump')")],
    },
    'Alt+Shift+1',
    'Mod+Alt+1',
    { digits: true },
  ),
  {
    id: 'rail',
    group: 'Panes',
    label: 'Show or hide the side rail',
    keys: [']'],
    handlers: [handler('src/components/cockpit/rail/useRailLayout.ts', "e.key !== ']'")],
  },
  {
    id: 'interrupt',
    group: 'Panes',
    label: 'Stop what the agent is doing (sends Ctrl+C to the focused pane)',
    keys: ['Ctrl+C'],
    handlers: [handler('src/terminal/canvas-terminal.ts', "event.key === 'c' && event.ctrlKey")],
  },
  {
    id: 'paste',
    group: 'Panes',
    label: 'Paste into the focused pane',
    keys: ['Mod+V'],
    handlers: [handler('src/terminal/xterm-textarea.ts', "event.key.toLowerCase() === 'v'")],
  },
  custom(
    {
      id: 'stop-all',
      group: 'Panes',
      label: 'Stop all agents, from any app (turn on in Settings)',
      handlers: [
        handler('src-tauri/src/panic.rs', 'pub const SHORTCUT: &str = "Ctrl+Alt+Shift+P"'),
        handler('src-tauri/src/global_shortcuts.rs', '("stop-all", "Mod+Alt+Shift+P", "Mod+Alt+Shift+P")'),
      ],
    },
    'Mod+Alt+Shift+P',
    'Mod+Alt+Shift+P',
    { scope: 'global' },
  ),

  // Search
  custom(
    {
      id: 'palette',
      group: 'Search',
      label: 'Open the command palette: switch panes, start an agent, run an action',
      handlers: [handler(COCKPIT, "matchesAction(e, 'palette')")],
    },
    'Mod+K',
    'Mod+K',
  ),
  custom(
    {
      id: 'search-chats',
      group: 'Search',
      label: 'Search what was said in all chats',
      handlers: [handler(COCKPIT, "matchesAction(e, 'search-chats')")],
    },
    'Mod+Shift+F',
    'Mod+Shift+F',
  ),
  {
    id: 'palette-move',
    group: 'Search',
    label: 'Move up and down the palette list',
    keys: ['↑', '↓'],
    handlers: [handler('src/components/cockpit/Palette.tsx', "e.key === 'ArrowDown'")],
  },
  {
    id: 'palette-open',
    group: 'Search',
    label: 'Open the highlighted row',
    keys: ['Enter'],
    handlers: [handler('src/components/cockpit/Palette.tsx', "e.key === 'Enter'")],
  },
  {
    id: 'palette-back',
    group: 'Search',
    label: 'In chat search with an empty box: back to the commands',
    keys: ['Backspace'],
    handlers: [handler('src/components/cockpit/Palette.tsx', "e.key === 'Backspace' && mode === 'chats'")],
  },
];

/** The entries a person can change. */
export const BINDABLE: readonly ShortcutEntry[] = SHORTCUTS.filter((s) => s.bind);

function entryOf(id: string): ShortcutEntry | undefined {
  return BINDABLE.find((s) => s.id === id);
}

// ---------------------------------------------------------------- the person's choices

/** Keeps the choices that mean something: a known action, and either "none" or a combo that parses. */
export function sanitizeKeybindings(raw: unknown): Keybindings {
  const out: Keybindings = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!entryOf(id) || typeof value !== 'string') continue;
    if (value === DISABLED) out[id] = DISABLED;
    else {
      const combo = normalizeBinding(value);
      if (combo) out[id] = combo;
    }
  }
  return out;
}

let current: Keybindings = {};
let version = 0;
const listeners = new Set<() => void>();

/** Sets the choices every handler and hint reads (CockpitApp does this from the settings). */
export function setKeybindings(raw: unknown): void {
  const next = sanitizeKeybindings(raw);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  version += 1;
  listeners.forEach((fn) => fn());
}

export function getKeybindings(): Keybindings {
  return current;
}

/** For `useSyncExternalStore`: changes whenever the choices change. */
export function subscribeKeybindings(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function keybindingsVersion(): number {
  return version;
}

/** The combo `id` has now: the choice, else the default for this platform. Null when turned off. */
export function effectiveBinding(id: string, overrides: Keybindings = current, mac: boolean = isMacPlatform()): string | null {
  const entry = entryOf(id);
  if (!entry?.bind) return null;
  const own = overrides[id];
  if (own === DISABLED) return null;
  if (own) return own;
  return mac ? entry.bind.mac : entry.bind.win;
}

/** The default combo for `id` on this platform. */
export function defaultBinding(id: string, mac: boolean = isMacPlatform()): string | null {
  const bind = entryOf(id)?.bind;
  return bind ? (mac ? bind.mac : bind.win) : null;
}

let recording = false;

/** Settings > Shortcuts sets this while its box listens for the next keys, so no shortcut fires meanwhile. */
export function setShortcutRecording(on: boolean): void {
  recording = on;
}

export function isShortcutRecording(): boolean {
  return recording;
}

/** Whether this key press is the shortcut `id` (with the person's choice applied). Never while keys are being recorded. */
export function matchesAction(e: KeyEventLike, id: string, mac: boolean = isMacPlatform()): boolean {
  return !recording && matchesBinding(e, effectiveBinding(id, current, mac), mac);
}

/** For a digits shortcut (jump to agent 1 to 9): the digit this key press is, or null. */
export function digitForAction(e: KeyEventLike, id: string, mac: boolean = isMacPlatform()): number | null {
  return recording ? null : digitFromEvent(e, effectiveBinding(id, current, mac), mac);
}

/** A combo as shown: `Ctrl+K`, `⌘K`; a digits shortcut shows `Alt+Shift+1–9`. */
export function bindingLabel(id: string, mac: boolean = isMacPlatform(), overrides: Keybindings = current): string {
  const combo = effectiveBinding(id, overrides, mac);
  if (!combo) return '';
  const text = formatKey(combo, mac);
  return entryOf(id)?.bind?.digits ? text.replace(/[1-9]$/, mac ? '1–9' : '1–9') : text;
}

/** The text for a hint or tooltip: ` (Ctrl+K)`, or nothing when the shortcut is off. */
export function bindingHint(id: string, mac: boolean = isMacPlatform()): string {
  const label = bindingLabel(id, mac);
  return label ? ` (${label})` : '';
}

/** The value for `aria-keyshortcuts`: `Control+Shift+M` (the Mod key is Meta on a Mac). Empty when the shortcut is off. */
export function ariaKeyshortcuts(id: string, mac: boolean = isMacPlatform()): string {
  const b = parseBinding(effectiveBinding(id, current, mac) ?? '');
  if (!b) return '';
  const f = wantsFlags(b, mac);
  const key = b.key === 'Left' ? 'ArrowLeft' : b.key === 'Right' ? 'ArrowRight' : b.key === 'Up' ? 'ArrowUp' : b.key === 'Down' ? 'ArrowDown' : b.key;
  return [f.ctrl && 'Control', f.meta && 'Meta', b.alt && 'Alt', b.shift && 'Shift', key].filter(Boolean).join('+');
}

/** The keys an entry shows on this platform, with the person's choices applied. Off: none. */
export function shortcutKeys(entry: ShortcutEntry, mac: boolean = isMacPlatform(), overrides: Keybindings = current): string[] {
  if (entry.bind) {
    const own = bindingLabel(entry.id, mac, overrides);
    return [...(own ? [own] : []), ...(entry.fixedKeys ?? [])];
  }
  return entry.keys.map((key) => formatKey(key, mac));
}

// ---------------------------------------------------------------- checking a new combo

export interface BindingProblem {
  kind: 'conflict' | 'reserved';
  /** Plain words for the person. */
  message: string;
}

export interface BindingCheck {
  /** Set: this combo cannot be used. */
  error: string | null;
  /** The person may still use the combo, knowingly. */
  warnings: BindingProblem[];
}

const TERMINAL_CTRL_LETTERS = new Set(['C', 'D', 'Z', 'L', 'R', 'A', 'E', 'K', 'U', 'W', 'S', 'Q', 'V', 'X']);
const MAC_SYSTEM_LETTERS = new Set(['C', 'V', 'X', 'A', 'Z', 'Q', 'W', 'H', 'M']);

/** The shape of a combo as a list of its parts, for comparing two combos. */
function shape(b: ParsedBinding, mac: boolean, digits: boolean): string {
  const f = wantsFlags(b, mac);
  const key = digits && /^[1-9]$/.test(b.key) ? '1-9' : b.key;
  return `${f.ctrl ? 'C' : ''}${f.meta ? 'M' : ''}${b.alt ? 'A' : ''}${b.shift ? 'S' : ''}+${key}`;
}

function sameShape(a: ParsedBinding, aDigits: boolean, b: ParsedBinding, bDigits: boolean, mac: boolean): boolean {
  const sa = shape(a, mac, aDigits);
  const sb = shape(b, mac, bDigits);
  if (sa === sb) return true;
  // A digits shortcut also takes every single digit with the same modifiers.
  if (aDigits && /^[1-9]$/.test(b.key)) return shape(a, mac, true) === shape(b, mac, true);
  if (bDigits && /^[1-9]$/.test(a.key)) return shape(a, mac, true) === shape(b, mac, true);
  return false;
}

/** Why the OS, terminals or the program in a pane already use this combo. Null when they do not. */
export function reservedReason(binding: string, mac: boolean): string | null {
  const b = parseBinding(binding);
  if (!b) return null;
  const f = wantsFlags(b, mac);
  const letter = /^[A-Z]$/.test(b.key);
  if (f.ctrl && !f.meta && !b.alt && !b.shift && letter && TERMINAL_CTRL_LETTERS.has(b.key)) {
    return `Terminals use ${formatKey(`Ctrl+${b.key}`, mac)} (stop, end, clear, edit the line). In a terminal pane the agent would not get it.`;
  }
  if (mac && f.meta && !f.ctrl && !b.alt && !b.shift && letter && MAC_SYSTEM_LETTERS.has(b.key)) {
    return `macOS uses ${formatKey(`Mod+${b.key}`, true)} for copy, paste, undo, quit, hide and similar.`;
  }
  if (!mac && f.meta) return 'Windows keeps most shortcuts that use the Windows key.';
  if (!mac && b.alt && !f.ctrl && ['F4', 'Tab', 'Esc', 'Space'].includes(b.key)) return `Windows uses ${formatKey(`Alt+${b.key}`, false)} (close, switch window, window menu).`;
  if (!mac && f.ctrl && b.alt && b.key === 'Delete') return 'Windows uses Ctrl+Alt+Delete.';
  if (!mac && f.ctrl && b.shift && b.key === 'Esc') return 'Windows uses Ctrl+Shift+Esc for Task Manager.';
  if (b.alt && !f.ctrl && !f.meta && !b.shift && letter) {
    return mac
      ? 'Option+letter types a special character in boxes and terminals.'
      : 'Terminals use Alt+letter to move and edit the line (Alt+B, Alt+F), so a pane would not get it.';
  }
  if (!f.ctrl && !f.meta && !b.alt && ['Esc', 'Enter', 'Tab', 'Backspace', 'Space'].includes(b.key)) return `${b.key} is used all over the app.`;
  return null;
}

/**
 * Whether `binding` can be the shortcut for `id`. `error` blocks it; `warnings` (taken by another action, or
 * reserved) are shown and the person may use it anyway.
 */
export function checkBinding(id: string, binding: string, overrides: Keybindings = current, mac: boolean = isMacPlatform()): BindingCheck {
  const entry = entryOf(id);
  const b = parseBinding(binding);
  if (!entry?.bind || !b) return { error: t('shortcuts.err.notCombo'), warnings: [] };
  const digits = entry.bind.digits === true;
  if (digits && !/^[1-9]$/.test(b.key)) return { error: t('shortcuts.err.digits'), warnings: [] };
  const holdsModifier = b.mod || b.ctrl || b.meta || b.alt;
  const functionKey = /^F\d+$/.test(b.key);
  if (!holdsModifier && !functionKey) {
    return { error: t('shortcuts.err.modifier', { key: mac ? '⌘' : t('shortcuts.winKey') }), warnings: [] };
  }
  if (entry.bind.scope === 'global' && !holdsModifier) return { error: t('shortcuts.err.global', { key: mac ? '⌘' : t('shortcuts.winKey') }), warnings: [] };
  const warnings: BindingProblem[] = [];
  for (const other of BINDABLE) {
    if (other.id === id) continue;
    const combo = effectiveBinding(other.id, overrides, mac);
    const parsed = combo ? parseBinding(combo) : null;
    if (parsed && sameShape(b, digits, parsed, other.bind?.digits === true, mac)) {
      warnings.push({ kind: 'conflict', message: t('shortcuts.err.usedBoth', { label: other.label }) });
    }
  }
  for (const other of SHORTCUTS) {
    if (other.bind) continue;
    for (const key of other.keys) {
      const parsed = parseBinding(key);
      if (parsed && (parsed.mod || parsed.ctrl || parsed.meta || parsed.alt) && sameShape(b, digits, parsed, false, mac)) {
        warnings.push({ kind: 'conflict', message: t('shortcuts.err.used', { label: other.label }) });
      }
    }
  }
  if (normalizeBinding(binding) !== normalizeBinding(defaultBinding(id, mac) ?? '')) {
    const why = reservedReason(binding, mac);
    if (why) warnings.push({ kind: 'reserved', message: why });
  }
  return { error: null, warnings };
}

// ---------------------------------------------------------------- recording

export type RecorderResult =
  | { kind: 'cancel' }
  | { kind: 'wait' }
  | { kind: 'combo'; binding: string };

/**
 * What one key press means while the "press the keys" box is listening: Esc alone cancels, a lone modifier
 * keeps waiting, anything else is the combo.
 */
export function recordKey(e: KeyEventLike, mac: boolean = isMacPlatform()): RecorderResult {
  const key = keyFromEvent(e);
  if (key === 'Esc' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) return { kind: 'cancel' };
  const binding = bindingFromEvent(e, mac);
  return binding ? { kind: 'combo', binding } : { kind: 'wait' };
}
