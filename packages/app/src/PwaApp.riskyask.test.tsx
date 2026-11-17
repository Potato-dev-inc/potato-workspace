// @vitest-environment jsdom
// The risky ask in the PWA root (phone slice 4): a medium or high risk ask of the chat you are in opens as a full card by itself, with the
// command folded; a low-risk ask stays in the dock; an ask of another chat never pulls you away.
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
  items: [] as unknown[],
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
    attention: async () => ({ v: 1, rev: 1, counts: { blocking: h.items.length, ready: 0 }, items: h.items }),
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
import { ITEM_HIGH, ITEM_LOW, ITEM_MEDIUM } from './dev/attention-fixtures';
import type { AttentionItem } from './lib/attention';
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
  h.items = [];
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

const peekButton = (name: string) => Array.from(host.querySelectorAll('[data-testid="phone-peek"] button')).find((b) => b.textContent === name) as HTMLButtonElement | undefined;
const openPeek = () => act(async () => (host.querySelector('.ph-head-title') as HTMLButtonElement).click());

const onPane = (item: AttentionItem, id: string): AttentionItem => ({ ...item, pane: { ...item.pane!, id } });
const card = () => host.querySelector('[data-testid="card-sheet"]');

describe('PwaApp: a risky ask is a full card', () => {
  it('a high-risk ask of the open chat opens the full card with no command until "Show the exact step"', async () => {
    h.items = [onPane(ITEM_HIGH, 'a1')];
    await open('a1');
    await flush();
    const full = card();
    expect(full?.getAttribute('data-full')).toBe('true');
    expect(full?.textContent).toContain('Delete a folder outside this project?');
    expect(full?.textContent).toContain('May not be possible');
    expect(full?.textContent).not.toContain('rm -rf');
    expect(full?.textContent).not.toContain('Run command');
    // "Do not allow" leads, then the hold button.
    const buttons = Array.from(full!.querySelectorAll('.ph-full-foot button')).map((b) => b.textContent);
    expect(buttons).toEqual(['Do not allow', 'Hold to allow once']);
    await act(async () => (buttonNamed('Show the exact step') as HTMLButtonElement).click());
    expect(card()?.textContent).toContain('rm -rf ../build-cache');
    expect(buttonNamed('Hide the exact step')).toBeDefined();
  });

  it('a medium-risk ask opens it too, and "Decide later" puts it away and it stays a one-line row in the dock', async () => {
    h.items = [onPane(ITEM_MEDIUM, 'a1')];
    await open('a1');
    await flush();
    expect(card()?.getAttribute('data-full')).toBe('true');
    await act(async () => (buttonNamed('Decide later') as HTMLButtonElement).click());
    await flush();
    expect(card()).toBeNull();
    const row = host.querySelector('[data-testid="risky-row"]') as HTMLButtonElement;
    expect(row).not.toBeNull();
    expect(row.textContent).not.toContain('npm install');
    await act(async () => row.click());
    expect(card()?.getAttribute('data-full')).toBe('true');
  });

  it('a low-risk ask does not open the full card; it stays in the dock', async () => {
    h.items = [onPane(ITEM_LOW, 'a1')];
    await open('a1');
    await flush();
    expect(card()).toBeNull();
    expect(host.querySelector('[data-testid="phone-ask-card"]')).not.toBeNull();
  });

  it('a risky ask of another chat does not open it', async () => {
    h.items = [onPane(ITEM_HIGH, 'someone-else')];
    await open('a1');
    await flush();
    expect(card()).toBeNull();
  });
});
