import { beforeEach, describe, expect, it, vi } from 'vitest';

const real = vi.hoisted(() => ({ calls: [] as { event: string; cb: (e: unknown) => void; off: ReturnType<typeof vi.fn>; resolve: () => void }[], defer: false }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, cb: (e: unknown) => void) => {
    const off = vi.fn();
    return new Promise((resolve) => {
      const go = () => resolve(off);
      real.calls.push({ event, cb, off, resolve: go });
      if (!real.defer) go();
    });
  }),
}));

import { listen, openListens } from './events';

beforeEach(() => {
  real.calls.length = 0;
  real.defer = false;
});

describe('event hub', () => {
  it('opens one real listen for many subscribers and fans out in order', async () => {
    const seen: string[] = [];
    const offs = await Promise.all([1, 2, 3].map((n) => listen<number>('x://a', (e) => seen.push(`${n}:${e.payload}`))));
    expect(real.calls).toHaveLength(1);
    real.calls[0]!.cb({ payload: 7 });
    expect(seen).toEqual(['1:7', '2:7', '3:7']);
    offs[0]!();
    real.calls[0]!.cb({ payload: 8 });
    expect(seen.slice(3)).toEqual(['2:8', '3:8']);
    offs[1]!();
    expect(real.calls[0]!.off).not.toHaveBeenCalled();
    offs[2]!();
    offs[2]!();
    expect(real.calls[0]!.off).toHaveBeenCalledTimes(1);
    expect(openListens()).toBe(0);
  });

  it('listens again after the last one left', async () => {
    (await listen('x://b', () => {}))();
    await listen('x://b', () => {});
    expect(real.calls).toHaveLength(2);
  });

  it('unlistens when the real listen lands after the last handler left', async () => {
    real.defer = true;
    const p = listen('x://c', () => {});
    const q = listen('x://c', () => {});
    expect(real.calls).toHaveLength(1);
    real.calls[0]!.resolve();
    const [a, b] = await Promise.all([p, q]);
    a();
    b();
    expect(real.calls[0]!.off).toHaveBeenCalledTimes(1);
  });

  it('a throwing handler does not stop the others', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: number[] = [];
    const a = await listen('x://d', () => {
      throw new Error('boom');
    });
    const b = await listen('x://d', () => seen.push(1));
    real.calls[0]!.cb({ payload: 1 });
    expect(seen).toEqual([1]);
    a();
    b();
    spy.mockRestore();
  });
});
