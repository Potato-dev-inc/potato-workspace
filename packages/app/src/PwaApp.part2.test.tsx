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
  rules: {} as Record<string, unknown>,
  interrupt: vi.fn(async (id: string) => ({ pane_id: id, stopped: true })),
  ask: vi.fn(async () => ({ asked: true })),
  listPanesError: null as Error | null,
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
    listPanes: async () => {
      if (h.listPanesError) throw h.listPanesError;
      return h.panes;
    },
    paneRules: async () => h.rules,
    interruptPane: h.interrupt,
    askControl: h.ask,
    killPane: async () => undefined,
    listAgentTypes: async () => ({}),
    getSettings: async () => ({}),
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
import { ITEM_HIGH, ITEM_LOW } from './dev/attention-fixtures';
import type { AttentionItem } from './lib/attention';
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
  h.rules = {};
  h.listPanesError = null;
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


const asItem = (base: typeof ITEM_LOW, paneId: string, heading: string): AttentionItem => ({ ...base, pane: { id: paneId, heading, agent: 'Codex', project: 'x' } });
const snapshotOf = (...items: AttentionItem[]) => ({ v: 1, rev: 5, counts: { blocking: items.length, ready: 0 }, items, device: { can_answer: true, can_type: true, can_control: true } });
const text = () => host.textContent ?? '';

describe('PwaApp: P8 the needs-you pill and the back arrow', () => {
  it('shows another agent that needs you above the message box, and a risky one jumps there with a back arrow', async () => {
    h.panes = [pane('a1', AGENT, 1), { ...pane('a2', AGENT, 2), status: 'waiting_input' }];
    h.attention = snapshotOf(asItem(ITEM_HIGH, 'a2', 'Docs agent'));
    await open('a1');
    await flush(2000);
    // Landing picks the chat that needs you; go to the other one first.
    await act(async () => menuButton().click());
    await act(async () => (Array.from(host.querySelectorAll('.ph-drow')).find((r) => r.textContent?.includes('Working') || r.getAttribute('data-state') === 'idle') as HTMLButtonElement).click());
    await flush();
    const pill = host.querySelector('[data-testid="needs-pill"]');
    expect(pill?.textContent).toContain('Docs agent');
    expect(host.querySelector('[data-testid="phone-back"]')).toBeNull();
    await act(async () => (pill!.querySelector('.ph-pill-main') as HTMLButtonElement).click());
    await flush();
    expect(h.paneChat).toHaveBeenCalledWith('a2', undefined);
    const back = host.querySelector('[data-testid="phone-back"]') as HTMLButtonElement;
    expect(back).not.toBeNull();
    await act(async () => back.click());
    await flush();
    expect(host.querySelector('[data-testid="phone-back"]')).toBeNull();
  });
});

describe('PwaApp: P7 the card sits in the conversation', () => {
  it('draws the open chat approval as the chat card', async () => {
    h.panes = [{ ...pane('a1', AGENT, 1), status: 'waiting_input' }];
    h.attention = snapshotOf(asItem(ITEM_LOW, 'a1', 'Billing tests'));
    await open('a1');
    await flush(2000);
    expect(host.querySelector('[data-testid="phone-ask-card"]')).not.toBeNull();
    expect(host.querySelector('.ph-appr')).toBeNull();
  });
});

describe('PwaApp: P9 stop', () => {
  it('Send is Stop while the agent works, and Stop reaches the PC', async () => {
    h.panes = [{ ...pane('a1', AGENT, 1), status: 'running' }];
    await open('a1');
    await flush(2000);
    const stop = host.querySelector('[data-testid="phone-stop"]') as HTMLButtonElement;
    expect(stop).not.toBeNull();
    await act(async () => { stop.click(); await vi.advanceTimersByTimeAsync(10); });
    expect(h.interrupt).toHaveBeenCalledWith('a1');
    expect(host.querySelector('[data-testid="phone-stopped-bar"]')).not.toBeNull();
  });

  it('a long press on a drawer row offers Stop and Close', async () => {
    h.panes = [pane('a1', AGENT, 1), { ...pane('a2', AGENT, 2), status: 'running' }];
    await open('a1');
    await flush(2000);
    await act(async () => menuButton().click());
    const running = Array.from(host.querySelectorAll('.ph-drow')).find((r) => r.getAttribute('data-state') === 'working') as HTMLButtonElement;
    await act(async () => { running.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    await act(async () => (Array.from(host.querySelectorAll('[role="menuitem"]')).find((b) => b.textContent === 'Stop') as HTMLButtonElement).click());
    expect(h.interrupt).toHaveBeenCalledWith('a2');
  });
});

describe('PwaApp: P20 agent rules', () => {
  it('a lock on the drawer row, and one sentence with Ask the PC for control instead of the box', async () => {
    h.panes = [pane('a1', AGENT, 1)];
    h.rules = { a1: { remote: true, level: 'watch' } };
    await open('a1');
    await flush(2000);
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.querySelector('[data-testid="phone-no-control"]')).not.toBeNull();
    await act(async () => (buttonNamed('Ask the PC for control') as HTMLButtonElement).click());
    expect(h.ask).toHaveBeenCalledWith('a1');
    await act(async () => menuButton().click());
    expect(host.querySelector('.ph-lock')?.getAttribute('aria-label')).toBe('Watch only on this phone');
  });

  it('the box is back after the PC lets the phone type again', async () => {
    h.panes = [pane('a1', AGENT, 1)];
    h.rules = { a1: { remote: true, level: 'watch' } };
    await open('a1');
    await flush(2000);
    expect(host.querySelector('textarea')).toBeNull();
    h.rules = {};
    await flush(6000);
    expect(host.querySelector('textarea')).not.toBeNull();
  });
});

describe('PwaApp: P18 the connection line', () => {
  it('says the link changed when the PC does not know this phone any more', async () => {
    h.panes = [pane('a1', AGENT, 1)];
    h.listPanesError = new Error('bridge GET /panes -> 401: {"error":"invalid_token"}');
    await open('a1');
    await flush(6000);
    expect(host.querySelector('[data-testid="phone-link-line"]')?.textContent).toContain('The link changed. Pair this phone again.');
  });

  it('says nothing when all is well', async () => {
    h.panes = [pane('a1', AGENT, 1)];
    await open('a1');
    await flush(2000);
    expect(host.querySelector('[data-testid="phone-link-line"]')).toBeNull();
  });
});

describe('PwaApp: P19 setup after pairing', () => {
  it('shows the three steps once after pairing, and Done keeps them away', async () => {
    h.panes = [pane('a1', AGENT, 1)];
    localStorage.setItem('pm.phone.setup', 'pending');
    await open('a1');
    await flush(500);
    expect(host.querySelector('[data-testid="phone-setup"]')).not.toBeNull();
    await act(async () => (Array.from(host.querySelectorAll('button')).find((b) => b.className.includes('ph-step-done')) as HTMLButtonElement).click());
    expect(host.querySelector('[data-testid="phone-setup"]')).toBeNull();
    expect(localStorage.getItem('pm.phone.setup')).toBe('done');
  });

  it('Settings has Help with the connection events and a test notification', async () => {
    h.panes = [pane('a1', AGENT, 1)];
    await open('a1');
    await flush(2000);
    await act(async () => menuButton().click());
    await act(async () => (host.querySelector('.ph-dsettings[aria-label="Settings"]') as HTMLButtonElement).click());
    expect(text()).toContain('Last connection events');
    expect(host.querySelector('[data-testid="phone-test-push"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="phone-link-events"]')).not.toBeNull();
  });
});

describe('PwaApp part 2 in Traditional Chinese', () => {
  afterEach(() => {
    useEnglish();
    setLanguagePref('en', false);
  });
  // The sentences the PC writes about a command (its headline, the command) come in English from the PC: they are not this screen words.
  const ownText = (el: Element) => visibleEnglish(el, ['Claude', 'Codex', 'Shell', 'PowerShell', 'Model']).filter((line) => !/Delete a folder outside this project|Run tests|Run command|Low risk|High risk/.test(line));

  it('the pill, the no-control box, the lock, the drawer and the settings sheet have no English left', async () => {
    useChinese();
    h.panes = [pane('a1', AGENT, 1), { ...pane('a2', AGENT, 2), status: 'waiting_input' }];
    h.attention = snapshotOf(asItem(ITEM_HIGH, 'a2', '文件助理'), asItem(ITEM_LOW, 'a1', '帳單測試'));
    h.rules = { a1: { remote: true, level: 'watch' } };
    await open('a1');
    await flush(2000);
    expect(host.querySelector('[data-testid="needs-pill"]')).not.toBeNull();
    expect(ownText(host.querySelector('[data-testid="needs-pill"]')!)).toEqual([]);
    expect(ownText(host.querySelector('[data-testid="phone-no-control"]')!)).toEqual([]);
    await act(async () => menuButton().click());
    expect(ownText(drawer()!)).toEqual([]);
    await act(async () => (host.querySelector('.ph-dsettings') as HTMLButtonElement).click());
    expect(ownText(host.querySelector('.ph-sheet')!)).toEqual([]);
  });

  it('the chat card and the setup steps have no English left', async () => {
    useChinese();
    h.panes = [{ ...pane('a1', AGENT, 1), status: 'waiting_input' }];
    h.attention = snapshotOf(asItem(ITEM_LOW, 'a1', '帳單測試'));
    localStorage.setItem('pm.phone.setup', 'pending');
    await open('a1');
    await flush(2000);
    // The command and the risk sentences are the PC's own words about the command: they are not translated here.
    expect(ownText(host.querySelector('[data-testid="phone-ask-card"]')!)).toEqual([]);
    expect(ownText(host.querySelector('[data-testid="phone-setup"]')!)).toEqual([]);
  });
});
