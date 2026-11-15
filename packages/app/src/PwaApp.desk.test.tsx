// @vitest-environment jsdom
// "Leaving my desk" on the phone, through the real PWA root: the card in the drawer reads the PC's state, switches it on for a
// chosen length (with the PC's screen control locked if asked) and ends it with I'm back. A phone that may only watch sees the
// state and no buttons.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ caps: ['watch', 'answer', 'type', 'control'], panes: [] as unknown[] }));

vi.mock('./hooks/usePaneViewportLease', () => ({ VIEWER_ID: 'v-test', usePaneViewportLease: () => vi.fn() }));
vi.mock('./hooks/useVisualViewport', () => ({ useVisualViewportSync: () => undefined }));
vi.mock('./hooks/usePushIntents', () => ({ usePushIntents: () => undefined }));
vi.mock('./lib/bridge-sse', () => ({
  subscribeBridgeEventsHandle: () => ({ unsubscribe: () => undefined, stats: () => null, onStats: () => () => undefined, setWatchedPanes: () => undefined, sendInput: () => false }),
}));
vi.mock('./lib/bridge', () => ({
  makeBridgeClient: () => ({
    baseUrl: 'http://phone.test',
    listPanes: async () => h.panes,
    getSettings: async () => ({}),
    listAgentTypes: async () => ({}),
    listPreviews: async () => ({}),
    attention: async () => ({ v: 1, rev: 1, counts: { blocking: 0, ready: 0 }, items: [] }),
    pairMe: async () => ({ local: false, caps: h.caps }),
    paneChat: async () => ({ available: true, reason: null, source: 'file', waitingFor: null, rev: 1, reset: false, items: [] }),
  }),
}));
vi.mock('./hooks/useBridgePaneRegistry', async () => {
  const React = await import('react');
  return {
    useBridgePaneRegistry: () => {
      const [list, setList] = React.useState<unknown[]>([]);
      const panes = React.useMemo(() => new Map((list as Array<{ id: string; status: string }>).map((info) => [info.id, { info, status: info.status }])), [list]);
      return {
        panes,
        paneList: [],
        subscribePaneData: () => () => undefined,
        ingestPaneResize: () => undefined,
        ingestTerminalData: () => undefined,
        updatePaneStatus: () => undefined,
        updatePaneDimensions: () => undefined,
        setPanesFromList: setList,
        resetStreams: () => undefined,
        makeTransport: () => ({ writeInput: () => true }),
      };
    },
  };
});
vi.mock('./components/BridgePaneTerminal', () => ({
  useBridgePaneTransport: (make: (id: string) => unknown, id: string) => make(id),
  BridgePaneTerminal: () => null,
}));

import PwaApp from './PwaApp';
import { setLanguagePref } from './i18n';
import { useChinese, useEnglish, visibleEnglish } from './i18n/test-utils';
import { fallbackListing } from './lib/agentRegistry';
import type { DeskAway } from './lib/desk-away';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AGENT = fallbackListing().agents.find((agent) => agent.kind !== 'shell')!.id;
let host: HTMLDivElement;
let root: Root;
/** What the PC says and what the phone sent it. */
let pc: DeskAway;
let sent: Array<{ method: string; path: string; body: unknown }>;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem('pm.bridge.url', 'http://phone.test');
  h.caps = ['watch', 'answer', 'type', 'control'];
  h.panes = [{ id: 'a1', agent_type: AGENT, status: 'idle', created_at: 1, cwd: 'C:/x', pid: 1, last_output_at: null, cols: 80, rows: 24 }];
  pc = { away: false, lock_screen: false, phones: 1 };
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const path = String(url).replace('http://phone.test', '');
      if (path === '/desk-away' || path === '/desk-away/back') {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(init.body) : undefined;
        sent.push({ method, path, body });
        if (method === 'POST' && path === '/desk-away') pc = { away: true, length: body.length, until_ms: null, by: 'phone', lock_screen: body.lock_screen, phones: 1 };
        if (path === '/desk-away/back') pc = { away: false, lock_screen: false, phones: 1 };
        return { ok: true, status: 200, json: async () => pc };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function openDrawer() {
  localStorage.setItem('pm.mobile.activeTab', 'a1');
  await act(async () => {
    root.render(<PwaApp />);
    await vi.advanceTimersByTimeAsync(300);
  });
  await act(async () => (host.querySelector('.ph-head-menu') as HTMLButtonElement).click());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
}
const card = () => host.querySelector('[data-testid="phone-desk"]');
const click = async (selector: string) => act(async () => (host.querySelector(selector) as HTMLElement).click());

describe('PwaApp: Leaving my desk', () => {
  it("the drawer has the card; it switches the PC on for the chosen length and I'm back ends it", async () => {
    await openDrawer();
    expect(card()).not.toBeNull();
    await click('[data-testid="phone-desk-open"]');
    const radios = [...card()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => r.parentElement!.textContent)).toEqual(["Until I'm back", '1 hour', '4 hours', 'Tonight, until 6 am']);
    await act(async () => radios[1].click());
    await act(async () => card()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await click('[data-testid="phone-desk-go"]');
    expect(sent.filter((s) => s.method === 'POST')).toEqual([{ method: 'POST', path: '/desk-away', body: { length: 'one_hour', lock_screen: true } }]);
    expect(card()!.textContent).toContain('You are away');
    expect(card()!.textContent).toContain('Screen control is locked');
    expect(card()!.textContent).toContain('Agents the PC keeps to itself stay locked');
    await click('[data-testid="phone-desk-back"]');
    expect(sent.at(-1)).toEqual({ method: 'POST', path: '/desk-away/back', body: {} });
    expect(card()!.textContent).not.toContain('You are away');
    expect(host.querySelector('[data-testid="phone-desk-open"]')).not.toBeNull();
  });

  it('shows the state the PC set (set on the PC: no note about locked agents), and picks up its end', async () => {
    pc = { away: true, length: 'until_back', until_ms: null, by: 'pc', lock_screen: false, phones: 1 };
    await openDrawer();
    expect(card()!.textContent).toContain('You are away');
    expect(card()!.textContent).not.toContain('keeps to itself');
    pc = { away: false, lock_screen: false, phones: 1 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(card()!.textContent).not.toContain('You are away');
  });

  it('a phone that may only watch sees the state and has no button to change it', async () => {
    h.caps = ['watch'];
    await openDrawer();
    expect(card()).toBeNull();
    pc = { away: true, length: 'until_back', until_ms: null, by: 'pc', lock_screen: false, phones: 1 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(card()!.textContent).toContain('You are away');
    expect(host.querySelector('[data-testid="phone-desk-back"]')).toBeNull();
  });

  it('tells the person when the PC could not be reached', async () => {
    await openDrawer();
    await click('[data-testid="phone-desk-open"]');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({ ok: false, status: 502, json: async () => ({}) }));
    await click('[data-testid="phone-desk-go"]');
    expect(card()!.textContent).toContain('Could not reach the PC');
  });

  it('has no English left in Traditional Chinese', async () => {
    useChinese();
    try {
      await openDrawer();
      expect(card()!.textContent).toContain('我要離開座位');
      expect(visibleEnglish(card()!)).toEqual([]);
    } finally {
      useEnglish();
      setLanguagePref('en', false);
    }
  });
});
