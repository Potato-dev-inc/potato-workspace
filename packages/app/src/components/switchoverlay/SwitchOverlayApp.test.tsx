// @vitest-environment jsdom
// The overlay's half of a switch: ready first (with what it saw), then the motion, and "done" never before the
// motion could have ended, even when every animation claims to be finished at once.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OverlayRun } from '../../lib/mode-switch/protocol';

const m = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  invoke: vi.fn(async (_command: string, _args?: unknown) => undefined),
  play: vi.fn(),
  cancel: vi.fn(),
  runs: [] as unknown[],
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: m.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
    m.handlers.set(event, (payload) => cb({ payload }));
    return () => m.handlers.delete(event);
  }),
}));
vi.mock('../../lib/settings', () => ({ loadSettings: vi.fn(async () => ({})) }));
vi.mock('../../lib/mode-switch/animate', () => ({
  // Every animation "finishes" at once: the failure to guard against.
  runSwitch: vi.fn((_root: HTMLElement, spec: unknown, opts: unknown) => {
    m.runs.push({ spec, opts });
    return { animations: [], finished: Promise.resolve(), play: m.play, cancel: m.cancel };
  }),
}));

import SwitchOverlayApp from './SwitchOverlayApp';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const monitor = { x: 0, y: 0, w: 2560, h: 1440, scale: 2 };
const rectOf = (x: number, y: number) => ({ x, y, w: 800, h: 600 });
const spec = (n: number, motion: OverlayRun['motion'] = 'domino'): OverlayRun => ({
  gen: 5,
  direction: 'individual',
  motion,
  monitor,
  proxies: Array.from({ length: n }, (_, i) => ({
    id: `acp-${i}-aaaaaaaaaaaa`,
    start: rectOf(100 * i, 50),
    end: rectOf(400 + 40 * i, 300),
    face: { kind: 'simple' as const, name: 'a', project: 'p', status: 'idle' },
    fromRow: false,
  })),
  miniBar: null,
  totalMs: 610,
});

const calls = (command: string) => m.invoke.mock.calls.filter((c) => c[0] === command);
let root: Root;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  // Frames: let the 2-frame wait resolve through its own timeout.
  vi.stubGlobal('requestAnimationFrame', () => 0);
  m.handlers.clear();
  m.invoke.mockClear();
  m.play.mockClear();
  m.runs.length = 0;
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(<SwitchOverlayApp />));
  await act(async () => undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.documentElement.className = '';
});

describe('SwitchOverlayApp', () => {
  it('makes the page transparent as soon as it mounts and gives it back on unmount', async () => {
    expect(document.documentElement.classList.contains('swo-root')).toBe(true);
    await act(async () => root.unmount());
    expect(document.documentElement.classList.contains('swo-root')).toBe(false);
    root = createRoot(document.createElement('div'));
  });

  it('starts paused, reports ready with what it saw, then plays; done only after the whole motion', async () => {
    await act(async () => void m.handlers.get('switch-overlay://run')?.(spec(2)));
    expect((m.runs[0] as { opts: { autoplay: boolean } }).opts.autoplay).toBe(false);
    expect(m.play).not.toHaveBeenCalled();
    await act(async () => void (await vi.advanceTimersByTimeAsync(250)));
    const ready = calls('switch_overlay_ready');
    expect(ready).toHaveLength(1);
    const info = (ready[0]![1] as { gen: number; info: Record<string, unknown> }).info;
    expect(info).toMatchObject({ motion: 'domino', direction: 'individual', expectedMs: 610, reducedMotion: false });
    expect((info.proxies as unknown[]).length).toBe(2);
    expect((info.proxies as Array<{ from: number[]; to: number[] }>)[1]).toMatchObject({ from: [50, 25, 400, 300], to: [220, 150, 400, 300] });
    expect(info.background).toBeTruthy();
    expect(m.play).toHaveBeenCalledTimes(1);
    // The animations said "finished" at once; done must still wait for the 530 ms + 80 ms stagger.
    expect(calls('switch_overlay_done')).toHaveLength(0);
    await act(async () => void (await vi.advanceTimersByTimeAsync(500)));
    expect(calls('switch_overlay_done')).toHaveLength(0);
    await act(async () => void (await vi.advanceTimersByTimeAsync(200)));
    const done = calls('switch_overlay_done');
    expect(done).toHaveLength(1);
    expect((done[0]![1] as { gen: number; info: { expectedMs: number; elapsedMs: number } }).info.elapsedMs).toBeGreaterThanOrEqual(610);
    expect((done[0]![1] as { gen: number }).gen).toBe(5);
  });

  it('the way back goes through the overlay as well and waits just as long', async () => {
    await act(async () => void m.handlers.get('switch-overlay://run')?.({ ...spec(1, 'ink'), direction: 'orchestration' }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(250)));
    expect(calls('switch_overlay_ready')).toHaveLength(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(600)));
    expect(calls('switch_overlay_done')).toHaveLength(0);
    await act(async () => void (await vi.advanceTimersByTimeAsync(200)));
    expect(calls('switch_overlay_done')).toHaveLength(1);
  });

  it('a cancel stops the run and says nothing more', async () => {
    await act(async () => void m.handlers.get('switch-overlay://run')?.(spec(2)));
    await act(async () => void (await vi.advanceTimersByTimeAsync(250)));
    await act(async () => void m.handlers.get('switch-overlay://cancel')?.({}));
    await act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
    expect(m.cancel).toHaveBeenCalled();
    expect(calls('switch_overlay_done')).toHaveLength(0);
  });
});
