// @vitest-environment jsdom
// 6 panes, 200 random switches (mount, unmount, quick remount, StrictMode style double mount): every open is closed again,
// and no listener stays on once the grace time has passed.
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = { open: [] as string[], close: [] as string[], on: 0, off: 0 };
const invoke = vi.fn(async (cmd: string, args?: { surface?: string }) => {
  if (cmd === 'session_chat_open') {
    calls.open.push(args!.surface!);
    return { available: true, reason: null, items: [], waitingFor: null };
  }
  if (cmd === 'session_chat_close') calls.close.push(args!.surface!);
  return undefined;
});
vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => {
    calls.on++;
    let done = false;
    return () => {
      if (!done) calls.off++;
      done = true;
    };
  },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...a) }));

import { chatStores, chatTuning } from './chatTuning';
import { resetEventHub, openListens } from '../lib/events';
import { useSessionChat } from './useSessionChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ paneId }: { paneId: string }) {
  useSessionChat(paneId, true);
  return null;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  calls.open.length = calls.close.length = 0;
  calls.on = calls.off = 0;
  resetEventHub();
  chatStores.clear();
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  chatTuning.graceMs = 2000;
  chatTuning.settleMs = 250;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

describe('useSessionChat store', () => {
  it('closes everything it opened and leaves no listener after the grace time', async () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 200; i++) {
      const pane = `p${Math.floor(rnd() * 6)}`;
      const strict = rnd() < 0.3;
      act(() => root.render(strict ? <StrictMode><Probe paneId={pane} /></StrictMode> : <Probe paneId={pane} />));
      await settle();
      // Sometimes stay long enough for the open to go out, sometimes pass over the pane within the debounce.
      await act(async () => { await vi.advanceTimersByTimeAsync(rnd() < 0.5 ? 20 : 400); });
      if (rnd() < 0.2) {
        act(() => root.render(<div />));
        await act(async () => { await vi.advanceTimersByTimeAsync(rnd() < 0.5 ? 100 : 2500); });
      }
    }
    act(() => root.render(<div />));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(calls.open.length).toBeGreaterThan(20);
    expect(calls.close.sort()).toEqual([...calls.open].sort());
    expect(calls.off).toBe(calls.on);
    expect(openListens()).toBe(0);
    expect(chatStores.size).toBe(0);
  });
});
