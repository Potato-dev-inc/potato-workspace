// @vitest-environment jsdom
// The glue of the phone redesign in the PWA root: the header says Sending / Working / Done in one place, the title is the task,
// the screen behind a drawer is inert and focus comes back, and Settings has the text size.
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

const buttonByLabel = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const flush = (ms = 50) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const menuButton = () => host.querySelector('.ph-head-menu') as HTMLButtonElement;
const headerName = () => host.querySelector('.ph-head-name')?.textContent;
const state = () => host.querySelector('.ph-head-state')?.textContent;
const FIRST = 'Fix the pairing check in the bridge so that a phone behind a tunnel cannot sneak in';
const DONE_TURN = [
  { kind: 'user', id: 'u1', at: null, text: FIRST },
  { kind: 'assistant', id: 'a1', at: null, text: 'Done.', model: null, finalAnswer: true },
  { kind: 'turnEnd', id: 'e1', at: null, outcome: 'completed', durationMs: 48_000 },
];

async function openChat(items: unknown[], over: Record<string, unknown> = {}) {
  h.panes = [{ ...pane('a1', AGENT, 1), ...over }];
  h.paneChat.mockResolvedValue({ available: true, reason: null, source: 'file', waitingFor: null, rev: 1, reset: true, items });
  await open('a1');
  await flush(2500);
}

describe('the header status and the title', () => {
  it('titles the chat from its first message (32 characters at most) when the PC gave no title', async () => {
    await openChat(DONE_TURN);
    const name = headerName() ?? '';
    expect(name.length).toBeLessThanOrEqual(32);
    expect(name.startsWith('Fix the pairing check')).toBe(true);
  });

  it('keeps the PC title when there is one', async () => {
    await openChat(DONE_TURN, { title: 'Pairing work' });
    expect(headerName()).toBe('Pairing work');
  });

  it('says Done with the time the last turn took, and never Idle', async () => {
    await openChat(DONE_TURN);
    expect(state()).toBe('Done · 48s');
    expect(host.textContent).not.toContain('Idle');
  });

  it('says Ready for a chat with no turn yet', async () => {
    await openChat([]);
    expect(state()).toBe('Ready');
  });

  it('says Working with the step and the plan size while a turn runs', async () => {
    const items = [
      { kind: 'user', id: 'u1', at: new Date(Date.now() - 12_000).toISOString(), text: 'do it' },
      { kind: 'plan', id: 'p1', at: null, replace: true, items: [{ text: 'one', status: 'completed' }, { text: 'two', status: 'in_progress' }, { text: 'three', status: 'pending' }] },
      { kind: 'toolCall', id: 'c1', at: null, callId: 'k1', name: 'Read', summary: 'a.ts', paths: ['a.ts'] },
    ];
    await openChat(items, { status: 'running' });
    expect(state()).toMatch(/^Working · \d+s · step 1 of 3$/);
  });

  it('says Sending… from the moment a message is sent until the PC has it, then falls back', async () => {
    let finish: (value: unknown) => void = () => undefined;
    h.send.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await openChat(DONE_TURN);
    const box = host.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(box, 'one more thing');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await flush(20);
    expect(state()).toBe('Sending…');
    await act(async () => finish({ id: 'm1', text: 'one more thing', createdAt: 1, state: 'queued', waitingFor: null, error: null }));
    await flush(20);
    expect(state()).not.toBe('Sending…');
  });
});

describe('the screen behind the drawer', () => {
  it('is inert and hidden from a screen reader while the drawer is open, and free again after', async () => {
    await openChat(DONE_TURN);
    const behind = host.querySelector('.ph-head')!.parentElement!;
    expect(behind.hasAttribute('inert')).toBe(false);
    await act(async () => menuButton().click());
    expect(behind.hasAttribute('inert')).toBe(true);
    expect(behind.getAttribute('aria-hidden')).toBe('true');
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(behind.hasAttribute('inert')).toBe(false);
    expect(behind.hasAttribute('aria-hidden')).toBe(false);
  });

  it('puts focus back on the menu button when the drawer closes', async () => {
    await openChat(DONE_TURN);
    menuButton().focus();
    await act(async () => menuButton().click());
    expect(document.activeElement).not.toBe(menuButton());
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(document.activeElement).toBe(menuButton());
  });
});

describe('Settings: text size', () => {
  it('has Small / Normal / Large; Large sets the phone size and is kept on this phone', async () => {
    await openChat(DONE_TURN);
    await act(async () => menuButton().click());
    await act(async () => host.querySelector<HTMLButtonElement>('.ph-dsettings')!.click());
    const group = host.querySelector('[data-testid="phone-text-size"] [role="radiogroup"]')!;
    const radios = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    expect(radios.map((r) => r.textContent)).toEqual(['Small', 'Normal', 'Large']);
    expect(radios[1]!.getAttribute('aria-checked')).toBe('true');
    await act(async () => radios[2]!.click());
    expect(host.querySelector('.ph')!.getAttribute('data-text')).toBe('large');
    expect(localStorage.getItem('potato.phone.textSize.v1')).toBe('large');
    expect(radios[2]!.getAttribute('aria-checked')).toBe('true');
    await act(async () => radios[0]!.click());
    expect(host.querySelector('.ph')!.getAttribute('data-text')).toBe('small');
  });
});
