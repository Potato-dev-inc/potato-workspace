// @vitest-environment jsdom
// Output follows the newest line only while the reader is at the bottom. A reader who scrolled up to read
// history stays put while an agent prints; typing, paste and the "Jump to latest" pill still go to the bottom.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({
  viewportY: 0,
  baseY: 0,
  scrolls: 0,
  options: null as Record<string, unknown> | null,
}));

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80;
    rows = 24;
    element = document.createElement('div');
    options: Record<string, unknown> = {};
    unicode = { activeVersion: '6' };
    constructor(opts: Record<string, unknown>) {
      this.options = opts;
      world.options = opts;
    }
    get buffer() {
      return { active: { type: 'normal', viewportY: world.viewportY, baseY: world.baseY, cursorY: 0 } };
    }
    loadAddon(addon: { activate?: (t: Terminal) => void }) {
      addon.activate?.(this);
    }
    open(target: HTMLElement) {
      target.appendChild(this.element);
    }
    onResize() {
      return { dispose() {} };
    }
    onData() {
      return { dispose() {} };
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }
    write(_data: unknown, cb?: () => void) {
      cb?.();
    }
    registerLinkProvider() {
      return { dispose() {} };
    }
    refresh() {}
    clearTextureAtlas() {}
    scrollToBottom() {
      world.scrolls += 1;
      world.viewportY = world.baseY;
    }
    focus() {}
    paste() {}
    reset() {}
    getSelection() {
      return '';
    }
    dispose() {}
  }
  return { Terminal };
});
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    private terminal: { resize: (c: number, r: number) => void } | null = null;
    activate(t: { resize: (c: number, r: number) => void }) {
      this.terminal = t;
    }
    proposeDimensions() {
      return { cols: 100, rows: 30 };
    }
    fit() {
      this.terminal?.resize(100, 30);
    }
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { JUMP_TO_LATEST_EVENT, TerminalSession } from './terminal-session';

class FakeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let container: HTMLElement;
let session: TerminalSession;
let output: (data: Uint8Array) => void;

const frames = (n = 3) => {
  for (let i = 0; i < n; i += 1) vi.advanceTimersByTime(20);
};

beforeEach(() => {
  vi.useFakeTimers();
  world.viewportY = 0;
  world.baseY = 0;
  world.scrolls = 0;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeObserver;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver;
  container = document.createElement('div');
  document.body.appendChild(container);
  session = new TerminalSession({ paneId: 'p1', syncPTYResize: true, onResize: () => undefined, onInput: () => undefined });
  session.mount(container, (_id, cb) => {
    output = cb;
    return () => undefined;
  });
  frames();
});
afterEach(() => {
  session.dispose();
  container.remove();
  vi.useRealTimers();
});

const chunk = new TextEncoder().encode('more output\r\n');

describe('terminal follows output only at the bottom', () => {
  it('scrolls to the newest line while the reader is at the bottom', () => {
    world.baseY = 50;
    world.viewportY = 50;
    const before = world.scrolls;
    output(chunk);
    expect(world.scrolls).toBeGreaterThan(before);
  });

  it('does not move a reader who scrolled up into history', () => {
    world.baseY = 200;
    world.viewportY = 120;
    const before = world.scrolls;
    output(chunk);
    output(chunk);
    expect(world.scrolls).toBe(before);
    expect(world.viewportY).toBe(120);
    expect(session.isScrolledUp()).toBe(true);
  });

  it('Jump to latest goes to the bottom, and output follows again afterwards', () => {
    world.baseY = 200;
    world.viewportY = 120;
    container.dispatchEvent(new CustomEvent(JUMP_TO_LATEST_EVENT));
    expect(world.viewportY).toBe(200);
    expect(session.isScrolledUp()).toBe(false);
    const before = world.scrolls;
    world.baseY = 210;
    world.viewportY = 210;
    output(chunk);
    expect(world.scrolls).toBeGreaterThan(before);
  });

  it('scrollToLatest also works as a method', () => {
    world.baseY = 80;
    world.viewportY = 10;
    session.scrollToLatest();
    expect(world.viewportY).toBe(80);
  });

  it('sets Option as Meta for Mac keyboards', () => {
    expect(world.options?.macOptionIsMeta).toBe(true);
  });
});
