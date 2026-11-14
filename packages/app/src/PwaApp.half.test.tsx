// @vitest-environment jsdom
// The phone's half-built pass at the PWA root: usage in the drawer foot, Light / Dark / Auto, the number on the app icon, the rule line, Potato while a chat opens.
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
    plansReport: async () => ({ month: { id: '2026-11', label: 'November 2026', startMs: 0, endMs: 1 }, months: [], rows: [], totals: { turns: 41, busyMs: 0, filesChanged: 0, added: 0, deleted: 0, merged: 0, limitHits: 0, limitedMs: 0 }, notes: [] }),
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

async function open(tab: string) {
  localStorage.setItem('pm.mobile.activeTab', tab);
  await act(async () => {
    root.render(<PwaApp />);
    await vi.advanceTimersByTimeAsync(50);
  });
}

const buttonNamed = (name: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === name);
const flush = (ms = 50) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

const drawer = () => host.querySelector('[data-testid="phone-drawer"]');
const menuButton = () => host.querySelector('.ph-head-menu') as HTMLButtonElement;
const rowTitles = (selector: string) => Array.from(host.querySelectorAll(selector + ' .ph-drow-title')).map((n) => n.textContent);
const headerName = () => host.querySelector('.ph-head-name')?.textContent;

const badge = { set: vi.fn(async (_n?: number) => undefined), clear: vi.fn(async () => undefined) };

describe('PwaApp half-built items', () => {
  beforeEach(() => {
    badge.set.mockClear();
    badge.clear.mockClear();
    Object.assign(navigator, { setAppBadge: badge.set, clearAppBadge: badge.clear });
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
    document.documentElement.removeAttribute('data-theme');
  });
  afterEach(() => {
    delete (navigator as { setAppBadge?: unknown }).setAppBadge;
    delete (navigator as { clearAppBadge?: unknown }).clearAppBadge;
    document.documentElement.removeAttribute('data-theme');
  });

  it('the drawer foot shows usage and a tap opens the usage sheet', async () => {
    await open('a1');
    await flush(2000);
    await act(async () => menuButton().click());
    await flush();
    const usage = host.querySelector('[data-testid="drawer-usage"]') as HTMLButtonElement;
    expect(usage).not.toBeNull();
    expect(host.querySelector('.ph-dfoot')?.contains(usage)).toBe(true);
    expect(usage.textContent).toContain('41 turns this month');
    await act(async () => usage.click());
    await flush();
    expect(drawer()).toBeNull();
    expect(host.textContent).toContain('Your plans');
  });

  it('Settings has Light / Dark / Auto: the choice is kept and put on the page', async () => {
    await open('a1');
    await flush(2000);
    expect(document.documentElement.dataset.theme).toBe('dark');
    await act(async () => menuButton().click());
    await act(async () => (host.querySelector('.ph-dsettings') as HTMLButtonElement).click());
    const choice = (name: string) => host.querySelector(`[data-theme-choice="${name}"]`) as HTMLButtonElement;
    expect(choice('auto').getAttribute('aria-checked')).toBe('true');
    await act(async () => choice('light').click());
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('potato.phone.theme.v1')).toBe('light');
    expect(choice('light').getAttribute('aria-checked')).toBe('true');
    await act(async () => choice('dark').click());
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('the app icon shows how many chats need you', async () => {
    h.panes = [pane('a1', AGENT, 1), { ...pane('a2', AGENT, 2), status: 'waiting_input' }, { ...pane('a3', AGENT, 3), status: 'waiting_input' }];
    await open('a1');
    await flush(2000);
    expect(badge.set).toHaveBeenLastCalledWith(2);
  });

  it('with nothing waiting the icon number is cleared', async () => {
    await open('a1');
    await flush(2000);
    expect(badge.set).not.toHaveBeenCalledWith(expect.any(Number));
    expect(badge.clear).toHaveBeenCalled();
  });

  it('a phone that may type but not control says so above the box; one that may control shows no line', async () => {
    h.caps = ['watch', 'answer', 'type'];
    await open('a1');
    await flush(2000);
    expect(host.querySelector('[data-testid="phone-rule-line"]')?.textContent).toContain('cannot stop or close');
    act(() => root.unmount());
    root = createRoot(host);
    h.caps = ['watch', 'answer', 'type', 'control'];
    await open('a1');
    await flush(2000);
    expect(host.querySelector('[data-testid="phone-rule-line"]')).toBeNull();
  });

  it('Potato waits with the chat while it opens', async () => {
    await open('a1');
    await flush(2000);
    const quiet = host.querySelector('[data-testid="phone-conversation"] [data-testid="phone-quiet"]');
    expect(quiet?.getAttribute('data-kind')).toBe('loading');
    expect(quiet?.querySelector('img')).not.toBeNull();
  });

  it('drawer rows say their state in colour (the word carries data-kind) as well as in the dot', async () => {
    h.panes = [{ ...pane('a1', AGENT, 1), status: 'running' }, { ...pane('a2', AGENT, 2), status: 'waiting_input' }];
    await open('a1');
    await flush(2000);
    await act(async () => menuButton().click());
    const kinds = Array.from(host.querySelectorAll('.ph-drow-state')).map((n) => n.getAttribute('data-kind'));
    expect(kinds).toContain('working');
    expect(kinds).toContain('needs');
  });
});
