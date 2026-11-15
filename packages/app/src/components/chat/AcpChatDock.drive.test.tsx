// @vitest-environment jsdom
// Screen level (desktop): "OPPO Reno13 is typing…" / "…is driving" on a chat another device drives, with Take back.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { AcpChatState } from '../../lib/acpChat';
import { fakeAcpApi } from '../../lib/acpChatFake';
import { useEnglish } from '../../i18n/test-utils';
import { AcpChatDock } from './AcpChatDock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
useEnglish();

const state = (over: Partial<AcpChatState> = {}): AcpChatState => ({
  lane: 'acp', agent: 'codex', label: 'Codex', phase: 'idle', status: 'idle', turnInFlight: false, stopping: false, canSteer: false,
  turn: 1, title: null, usage: null, permissions: [], closed: false, ...over,
});
const c = { now: 5, asked: { questions: [], answerQuestion: vi.fn(), dismissQuestion: vi.fn() } } as unknown as CockpitApi;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function mount(initial: AcpChatState, takeBack: () => Promise<string | null> = vi.fn(async () => 'phone-1')) {
  let push: ((id: string, next: AcpChatState) => void) | null = null;
  const api = fakeAcpApi({
    state: async () => initial,
    takeBack,
    watch: async (cb) => {
      push = cb;
      return () => undefined;
    },
  });
  await act(async () => {
    root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />);
  });
  return { takeBack, emit: (next: AcpChatState) => act(async () => push?.('p1', next)) };
}
const strip = () => host.querySelector('[data-testid="acp-drive"]');
const driver = (typing: boolean, typing_ms = 0) => ({ driver: { id: 'phone-1', name: 'OPPO Reno13', typing, typing_ms } });

describe('another device drives the chat', () => {
  it('shows nothing when this PC drives', async () => {
    await mount(state());
    expect(strip()).toBeNull();
  });

  it('says who is typing, then who is driving, and Take back makes this PC the driver', async () => {
    const takeBack = vi.fn(async () => 'phone-1');
    const { emit } = await mount(state({ drive: driver(true, 6000) }), takeBack);
    expect(strip()?.textContent).toContain('OPPO Reno13 is typing…');
    await emit(state({ drive: driver(false) }));
    expect(strip()?.textContent).toContain('OPPO Reno13 is driving');
    await act(async () => {
      (strip()?.querySelector('button') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(takeBack).toHaveBeenCalledWith('p1');
    // The PC's state comes back with nobody driving: the chip goes.
    await emit(state({ drive: { driver: null, took_back: { by: 'local', by_name: "Ren's PC", from: 'phone-1' } } }));
    expect(strip()).toBeNull();
  });

  it('shows the typing line only for as long as the signal counts', async () => {
    vi.useFakeTimers();
    try {
      await mount(state({ drive: driver(true, 2000) }));
      expect(strip()?.textContent).toContain('is typing…');
      await act(async () => {
        vi.advanceTimersByTime(2500);
      });
      expect(strip()?.textContent).toContain('is driving');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so when Take back fails', async () => {
    const takeBack = vi.fn(async (): Promise<string | null> => {
      throw new Error('no');
    });
    await mount(state({ drive: driver(false) }), takeBack);
    await act(async () => {
      (strip()?.querySelector('button') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(takeBack).toHaveBeenCalled();
    expect(strip()?.textContent).toContain('Could not take this back');
  });
});
