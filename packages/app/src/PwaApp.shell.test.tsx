// @vitest-environment jsdom
// The phone's chat-app shape in the PWA root: it opens in the chat that needs you (else the one read last), the drawer lists
// who needs you first and the rest by project, and the header is three things.
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

describe('PwaApp opens in a conversation', () => {
  it('opens in the chat that needs you, not the one read last', async () => {
    h.panes = [pane('a1', AGENT, 1), { ...pane('a2', AGENT, 2), status: 'waiting_input' }, pane('s1', SHELL, 3)];
    await open('a1');
    await flush(2000);
    expect(host.querySelector('[data-testid="phone-chat"]')).not.toBeNull();
    expect(headerName()).toContain('2');
    expect(h.paneChat).toHaveBeenCalledWith('a2', undefined);
  });

  it('opens in the PC list\'s oldest waiting chat when two wait', async () => {
    h.panes = [pane('a1', AGENT, 1), pane('a2', AGENT, 2)];
    const item = (id: string, pane: string, since: number) => ({ id, key: 'approval:' + id, kind: 'approval', lane: 'blocking', rank: 1, state: 'open', since_ms: since, expires_at_ms: null, pane: { id: pane, heading: pane, agent: null, project: null }, title: 't', sentence: null, risk: null, prompt: null, actions: [], resolution: null });
    h.attention = { v: 1, rev: 2, counts: { blocking: 2, ready: 0 }, items: [item('i1', 'a1', 2000), item('i2', 'a2', 1000)] };
    await open('all');
    await flush(2000);
    expect(h.paneChat).toHaveBeenCalledWith('a2', undefined);
  });

  it('with nothing waiting it opens the chat read last', async () => {
    h.panes = [pane('a1', AGENT, 1), pane('a2', AGENT, 2)];
    await open('a2');
    await flush(2000);
    expect(h.paneChat).toHaveBeenCalledWith('a2', undefined);
    expect(h.paneChat).not.toHaveBeenCalledWith('a1', undefined);
  });

  it('a first start with no history opens the first chat, not an Agents home', async () => {
    h.panes = [pane('a1', AGENT, 1), pane('a2', AGENT, 2)];
    localStorage.removeItem('pm.mobile.activeTab');
    await act(async () => {
      root.render(<PwaApp />);
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(h.paneChat).toHaveBeenCalledWith('a1', undefined);
    expect(host.textContent).not.toContain('waiting');
  });
});

describe('PwaApp in Traditional Chinese', () => {
  afterEach(() => {
    useEnglish();
    setLanguagePref('en', false);
  });

  it('the header, the drawer and the composer have no English left in them', async () => {
    useChinese();
    h.panes = [pane('a1', AGENT, 1), { ...pane('a2', AGENT, 2), status: 'waiting_input' }];
    h.attention = { v: 1, rev: 2, counts: { blocking: 1, ready: 0 }, items: [] };
    await open('a1');
    await flush(2000);
    const shell = host.querySelector('.pwa-shell')!;
    // Agent names (Claude, Codex) and the model are brand names; the words around them must be Chinese.
    const ownText = (root: Element) => visibleEnglish(root, ['Claude', 'Codex', 'Shell', 'PowerShell', 'Bash', 'Model']);
    expect(ownText(host.querySelector('.ph-head')!)).toEqual([]);
    expect(ownText(host.querySelector('[data-testid="phone-composer"]')!)).toEqual([]);
    await act(async () => menuButton().click());
    expect(ownText(drawer()!)).toEqual([]);
    expect(shell).not.toBeNull();
  });
});

describe('PwaApp drawer', () => {
  it('lists Needs you first, then the rest grouped by project', async () => {
    h.panes = [
      { ...pane('a1', AGENT, 1), cwd: 'C:/work/billing' },
      { ...pane('a2', AGENT, 2), cwd: 'C:/work/docs', status: 'waiting_input' },
      { ...pane('a3', AGENT, 3), cwd: 'C:/work/docs' },
      { ...pane('a4', AGENT, 4), cwd: 'C:/work/billing' },
    ];
    await open('a1');
    await flush(2000);
    await act(async () => menuButton().click());
    expect(drawer()).not.toBeNull();
    const sections = Array.from(host.querySelectorAll('.ph-dsec')).map((n) => n.textContent);
    expect(sections).toEqual(['Needs you', 'billing', 'docs']);
    expect(rowTitles('[data-testid="drawer-needs"]')).toHaveLength(1);
    const projects = Array.from(host.querySelectorAll('[data-testid="drawer-project"]'));
    expect(projects.map((list) => list.querySelectorAll('.ph-drow').length)).toEqual([2, 1]);
  });

  it('rows show the brand icon, a state dot and the state in words', async () => {
    h.panes = [{ ...pane('a1', AGENT, 1), status: 'running' }, { ...pane('a2', AGENT, 2), status: 'error' }, pane('a3', AGENT, 3)];
    await open('a1');
    await flush(2000);
    await act(async () => menuButton().click());
    const rows = Array.from(host.querySelectorAll('.ph-drow'));
    const byState = (state: string) => rows.find((r) => r.getAttribute('data-state') === state);
    expect(byState('working')?.querySelector('.ph-dot')).not.toBeNull();
    expect(byState('working')?.querySelector('svg, [class*="agent-logo"], .al')).not.toBeNull();
    expect(byState('working')?.textContent).toContain('Working');
    expect(byState('broken')?.textContent).toContain('Stopped');
    expect(byState('idle')?.textContent).toContain('Ready');
    expect(byState('idle')?.textContent).not.toContain('Idle');
    // Idle chats have no dot: grey means nothing.
    expect(byState('idle')?.querySelector('.ph-dot')).toBeNull();
  });

  it('picking a row opens that chat and closes the drawer; Escape closes it too', async () => {
    h.panes = [pane('a1', AGENT, 1), pane('a2', AGENT, 2)];
    await open('a1');
    await flush(2000);
    await act(async () => menuButton().click());
    const rows = Array.from(host.querySelectorAll('.ph-drow')) as HTMLButtonElement[];
    await act(async () => rows[1]!.click());
    await flush();
    expect(drawer()).toBeNull();
    expect(h.paneChat).toHaveBeenCalledWith('a2', undefined);
    await act(async () => menuButton().click());
    expect(drawer()).not.toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(drawer()).toBeNull();
  });

  it('opens on a swipe from the left edge, not from the middle', async () => {
    h.panes = [pane('a1', AGENT, 1)];
    await open('a1');
    await flush(2000);
    const shell = host.querySelector('.pwa-shell')!;
    const touch = (type: string, x: number, y = 300) => {
      const event = new Event(type, { bubbles: true }) as Event & { touches: unknown[] };
      event.touches = [{ clientX: x, clientY: y }];
      shell.dispatchEvent(event);
    };
    await act(async () => {
      touch('touchstart', 120);
      touch('touchmove', 260);
    });
    expect(drawer()).toBeNull();
    await act(async () => {
      touch('touchstart', 6);
      touch('touchmove', 90);
    });
    expect(drawer()).not.toBeNull();
  });

  it('the menu button says how many chats wait', async () => {
    h.panes = [{ ...pane('a1', AGENT, 1), status: 'waiting_input' }, { ...pane('a2', AGENT, 2), status: 'waiting_input' }, pane('a3', AGENT, 3)];
    h.attention = { v: 1, rev: 2, counts: { blocking: 2, ready: 0 }, items: [] };
    await open('a3');
    await flush(2000);
    expect(menuButton().getAttribute('aria-label')).toBe('Open chats, 2 waiting');
    expect(host.querySelector('.ph-badge')?.textContent).toBe('2');
  });

  it('the header is three things: menu, the chat name with its state, and a new chat', async () => {
    h.panes = [pane('a1', AGENT, 1)];
    await open('a1');
    await flush(2000);
    const header = host.querySelector('.ph-head')!;
    expect(header.querySelectorAll('button')).toHaveLength(3);
    expect(header.querySelector('.ph-head-state')?.textContent).toBe('Ready');
    expect(header.querySelector('[aria-label="New chat"]')).not.toBeNull();
  });
});
