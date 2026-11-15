// @vitest-environment jsdom
// What's new on the phone, through the real PwaApp: it opens once per version after the phone connects (one column, only the
// cards that suit a phone, from the same highlights file), the seen mark is kept, and Menu > About > What's new opens it again.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  claim: vi.fn(),
  terminalMounts: 0,
  terminalUnmounts: 0,
  paneChat: vi.fn(),
  panes: [] as unknown[],
  caps: ['watch', 'answer', 'type', 'control'],
  attention: null as unknown,
}));

vi.mock('./hooks/usePaneViewportLease', () => ({
  VIEWER_ID: 'v-test',
  usePaneViewportLease: () => h.claim,
}));
vi.mock('./hooks/useVisualViewport', () => ({ useVisualViewportSync: () => undefined }));
vi.mock('./hooks/usePushIntents', () => ({ usePushIntents: () => undefined }));
vi.mock('./lib/bridge-sse', () => ({
  subscribeBridgeEventsHandle: () => ({
    unsubscribe: () => undefined,
    stats: () => null,
    onStats: () => () => undefined,
    setWatchedPanes: () => undefined,
    sendInput: () => false,
  }),
}));
vi.mock('./lib/bridge', () => ({
  makeBridgeClient: () => ({
    baseUrl: 'http://phone.test',
    listPanes: async () => h.panes,
    getSettings: async () => ({}),
    listAgentTypes: async () => ({}),
    listPreviews: async () => ({}),
    attention: async () => h.attention ?? { v: 1, rev: 1, counts: { blocking: 0, ready: 0 }, items: [] },
    pairMe: async () => ({ local: false, caps: h.caps }),
    paneChat: h.paneChat,
  }),
}));
vi.mock('./hooks/useBridgePaneRegistry', async () => {
  const React = await import('react');
  return {
    useBridgePaneRegistry: () => {
      const [list, setList] = React.useState<unknown[]>([]);
      const panes = React.useMemo(
        () => new Map((list as Array<{ id: string; status: string }>).map((info) => [info.id, { info, status: info.status }])),
        [list],
      );
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
vi.mock('./components/BridgePaneTerminal', async () => {
  const React = await import('react');
  return {
    useBridgePaneTransport: (make: (id: string) => unknown, id: string) => make(id),
    BridgePaneTerminal: ({ pane }: { pane: { id: string } }) => {
      React.useEffect(() => {
        h.terminalMounts += 1;
        return () => {
          h.terminalUnmounts += 1;
        };
      }, []);
      return <div data-testid="terminal" data-pane={pane.id} />;
    },
  };
});

import PwaApp from './PwaApp';
import { setLanguagePref } from './i18n';
import { useChinese, useEnglish, visibleEnglish } from './i18n/test-utils';
import { fallbackListing } from './lib/agentRegistry';
import { LS_PANE_VIEWS } from './lib/mobile-pane-view';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listing = fallbackListing();
const SHELL = listing.agents.find((agent) => agent.kind === 'shell')!.id;
const AGENT = listing.agents.find((agent) => agent.kind !== 'shell')!.id;
const pane = (id: string, agent: string, created_at: number) => ({
  id,
  agent_type: agent,
  status: 'idle',
  created_at,
  cwd: 'C:/x',
  pid: 1,
  last_output_at: null,
  cols: 80,
  rows: 24,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useEnglish();
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem('pm.bridge.url', 'http://phone.test');
  h.claim.mockClear();
  h.terminalMounts = 0;
  h.terminalUnmounts = 0;
  h.caps = ['watch', 'answer', 'type', 'control'];
  h.attention = null;
  h.panes = [pane('a1', AGENT, 1), pane('s1', SHELL, 2)];
  h.paneChat.mockReset();
  h.paneChat.mockResolvedValue({ available: true, reason: null, source: 'file', waitingFor: null, rev: 1, reset: false, items: [] });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
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

async function open() {
  localStorage.setItem('pm.mobile.activeTab', 'a1');
  await act(async () => {
    root.render(<PwaApp />);
    await vi.advanceTimersByTimeAsync(2000);
  });
}
const flush = (ms = 50) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const sheet = () => host.querySelector('[data-testid="phone-whatsnew"]');
const button = (text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

describe('What is new on the phone', () => {
  it('opens once per version after the phone connects: one column, phone cards only, and the version is marked seen', async () => {
    await open();
    expect(sheet()).not.toBeNull();
    const cards = Array.from(host.querySelectorAll('[data-card]')).map((c) => c.getAttribute('data-card'));
    // 1.1.1 has one card that suits a phone (the theme); every desktop-only card is left out.
    expect(cards).toEqual(['theme-dim']);
    expect(sheet()!.textContent).toContain('Light, dimmed');
    expect(sheet()!.textContent).not.toContain('Drag an agent to split');
    expect(localStorage.getItem('pm.whatsnew.seen')).toBe('1.1.1');
  });

  it('Done closes it, and it does not come back on its own', async () => {
    await open();
    await act(async () => button('Done')!.click());
    await flush(400);
    expect(sheet()).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    await open();
    expect(sheet()).toBeNull();
  });

  it('Menu > About > What is new opens it again, and its "Try it" goes to the Display rows', async () => {
    localStorage.setItem('pm.whatsnew.seen', '1.1.1');
    await open();
    expect(sheet()).toBeNull();
    await act(async () => (host.querySelector('.ph-head-menu') as HTMLButtonElement).click());
    await flush(400);
    await act(async () => (host.querySelector('.ph-dsettings') as HTMLButtonElement).click());
    await flush();
    await act(async () => (host.querySelector('[data-testid="phone-menu-whatsnew"]') as HTMLButtonElement).click());
    await flush();
    expect(sheet()).not.toBeNull();
    await act(async () => button('Try the theme')!.click());
    await flush();
    expect(sheet()).toBeNull();
    expect(host.textContent).toContain('Display');
  });
});
