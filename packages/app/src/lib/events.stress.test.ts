import { describe, expect, it, vi } from 'vitest';

const real = vi.hoisted(() => ({ listens: 0, offs: 0, live: new Set<number>(), seq: 0 }));
vi.mock('@tauri-apps/api/event', () => ({
  // A real listen lands after a random delay, so a subscriber can leave while it is still in flight.
  listen: vi.fn(
    (_event: string) =>
      new Promise((resolve) => {
        const id = ++real.seq;
        real.listens++;
        real.live.add(id);
        setTimeout(() => resolve(() => (real.live.delete(id), real.offs++)), Math.floor(Math.random() * 4));
      }),
  ),
}));

import { listen, openListens } from './events';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('event hub under random mounts and unmounts', () => {
  it('leaves no real listen open once every subscriber is gone', async () => {
    const names = ['a://x', 'b://y', 'c://z'];
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < 200; i++) {
      jobs.push(
        (async () => {
          await sleep(Math.floor(Math.random() * 30));
          const p = listen(names[i % 3]!, () => undefined);
          // Some leave the moment their listen lands, some after a while, some twice (a double cleanup).
          const off = await p;
          await sleep(Math.floor(Math.random() * 10));
          off();
          if (i % 7 === 0) off();
        })(),
      );
    }
    await Promise.all(jobs);
    await sleep(20);
    expect(openListens()).toBe(0);
    expect(real.live.size).toBe(0);
    expect(real.offs).toBe(real.listens);
  });
});
