// @vitest-environment jsdom
// The phone opens on the default companion: its entry comes first in the drawer, the others keep their order.
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
  send: vi.fn(),
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
    attention: async () => h.attention ?? { v: 1, rev: 1, counts: { blocking: 0, ready: 0 }, items: [] },
    pairMe: async () => ({ local: false, caps: h.caps }),
    paneChat: h.paneChat,
    sendPaneMessage: h.send,
    listPaneMessages: async () => [],
    listQuestions: async () => [],
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

const comps = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('./hooks/useBridgeCompanions', () => ({
  useBridgeCompanions: () => ({ companions: comps.list, loaded: true, applyView: () => undefined }),
}));

import PwaApp from './PwaApp';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const companion = (id: string, name: string, isDefault: boolean) => ({
  id,
  name,
  avatar: 'mochi',
  isDefault,
  persona: 'calm',
  agentType: 'claude',
  agentLabel: 'Claude',
  folderName: 'home',
  state: 'idle',
  stateLine: 'Here.',
  paneId: null,
  needs: null,
  pendingMemory: 0,
  nextCheckin: null,
  restarts: 0,
  autoStart: true,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem('pm.bridge.url', 'http://phone.test');
  h.panes = [];
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

describe('the phone and more than one companion', () => {
  it('lists the default companion first, whatever order the PC sends', async () => {
    comps.list = [companion('mochi', 'Mochi', false), companion('bit', 'Bit', true), companion('nib', 'Nib', false)];
    await act(async () => {
      root.render(<PwaApp />);
      await vi.advanceTimersByTimeAsync(50);
    });
    act(() => host.querySelector<HTMLButtonElement>('.ph-head-menu')!.click());
    const names = [...host.querySelectorAll('section[aria-label] .ph-drow-title')].map((n) => n.textContent);
    expect(names.slice(0, 3)).toEqual(['Bit', 'Mochi', 'Nib']);
  });
});
