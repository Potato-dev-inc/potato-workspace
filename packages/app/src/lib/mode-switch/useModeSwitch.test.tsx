// @vitest-environment jsdom
// The cockpit's half of the switch: answers `prepare` with the proxies, gets out of the way, and always lets go on `finish`.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwitchEvent } from './protocol';

const m = vi.hoisted(() => ({
  handler: null as null | ((e: unknown) => void),
  begin: vi.fn(async (_gen: number, _spec: unknown) => undefined),
}));

vi.mock('../cockpit-api', () => ({
  cockpitApi: {
    onModeSwitch: vi.fn(async (cb: (e: unknown) => void) => {
      m.handler = cb;
      return () => {
        m.handler = null;
      };
    }),
    modeSwitchBegin: m.begin,
  },
}));

import { useModeSwitch } from './useModeSwitch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  useModeSwitch({ activeId: 'a', describe: (id) => ({ name: id, project: 'proj', status: 'idle' }) });
  return null;
}

let root: Root;
const rect = (el: Element, [left, top, width, height]: number[]) => {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
};
const monitor = { x: 0, y: 0, w: 3840, h: 2160, scale: 1 };
const prepare = (direction: 'individual' | 'orchestration', windows = [{ id: 'a', rect: { x: 800, y: 300, w: 500, h: 400 } }]): SwitchEvent => ({
  phase: 'prepare',
  gen: 7,
  direction,
  style: 'domino',
  monitor,
  origin: { x: 0, y: 0 },
  windows,
  miniBar: null,
});
const send = (e: SwitchEvent) => act(async () => void m.handler?.(e));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  document.body.innerHTML = '<div class="cockpit"><div data-pane-tile="a"></div><button data-pane-row="a"></button></div>';
  rect(document.querySelector('[data-pane-tile="a"]')!, [260, 80, 800, 600]);
  rect(document.querySelector('[data-pane-row="a"]')!, [6, 200, 228, 32]);
  m.begin.mockClear();
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Probe />));
  await act(async () => undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  document.documentElement.className = '';
});

describe('useModeSwitch', () => {
  it('to Individual: hands Rust the proxies, then fades the cockpit; finish gives everything back', async () => {
    await send(prepare('individual'));
    expect(m.begin).toHaveBeenCalledTimes(1);
    const [gen, spec] = m.begin.mock.calls[0] as [number, { motion: string; totalMs: number; proxies: Array<{ id: string; fromRow: boolean }> }];
    expect(gen).toBe(7);
    expect(spec.motion).toBe('domino');
    expect(spec.totalMs).toBe(530);
    expect(spec.proxies.map((p) => [p.id, p.fromRow])).toEqual([['a', false]]);
    expect(document.documentElement.classList.contains('sw-out')).toBe(true);
    await send({ phase: 'finish', gen: 7 });
    expect(document.documentElement.classList.contains('sw-out')).toBe(false);
  });

  it('with nothing to animate it still answers (so Rust switches at once) and leaves the cockpit alone', async () => {
    document.body.innerHTML = '<div class="cockpit"></div>';
    await send(prepare('individual'));
    expect(m.begin).toHaveBeenCalledWith(7, expect.objectContaining({ proxies: [], totalMs: 0 }));
    expect(document.documentElement.classList.contains('sw-out')).toBe(false);
  });

  it('coming back: hold keeps the content invisible, the tile stays hidden until the end, finish releases it', async () => {
    await send({ phase: 'hold', gen: 7 });
    expect(document.documentElement.classList.contains('sw-hold')).toBe(true);
    await act(async () => {
      m.handler?.(prepare('orchestration'));
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(m.begin).toHaveBeenCalledTimes(1);
    const tile = document.querySelector('[data-pane-tile="a"]')!;
    expect(tile.hasAttribute('data-sw-hide')).toBe(true);
    // The content fades back in just before the proxies land (140 ms before the end of the motion).
    await act(async () => void (await vi.advanceTimersByTimeAsync(500)));
    expect(document.documentElement.classList.contains('sw-in')).toBe(true);
    await send({ phase: 'finish', gen: 7 });
    expect(document.documentElement.className).toBe('');
    expect(tile.hasAttribute('data-sw-hide')).toBe(false);
  });

  it('lets go by itself if Rust never says finish', async () => {
    await send({ phase: 'hold', gen: 7 });
    await act(async () => void (await vi.advanceTimersByTimeAsync(4100)));
    expect(document.documentElement.classList.contains('sw-hold')).toBe(false);
  });
});
