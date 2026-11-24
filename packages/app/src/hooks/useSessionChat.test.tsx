// @vitest-environment jsdom
// The chat hook: what an empty chat is waiting for (from the open answer, then from status events), and
// the open / close / open a dev build's StrictMode does at once.
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const handlers = new Map<string, (e: { payload: unknown }) => void>();
const listen = vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
  handlers.set(event, cb);
  return () => handlers.delete(event);
});
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listen(...(a as Parameters<typeof listen>)) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { chatTuning } from './chatTuning';
import { CHAT_OPEN_STAGES } from '../lib/chatTiming';
import { useSessionChat, type SessionChatHook } from './useSessionChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WAITING = 'Looking in C:\\x\\projects\\p for a file written after 05:03:05.';

let host: HTMLDivElement;
let root: Root;
let latest: SessionChatHook;

function Probe({ paneId }: { paneId: string }) {
  latest = useSessionChat(paneId, true);
  return null;
}

const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  listen.mockClear();
  handlers.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('useSessionChat waiting line', () => {
  it('takes what the chat waits for from the open answer', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'session_chat_open' ? { available: true, reason: null, items: [], waitingFor: WAITING } : undefined,
    );
    act(() => root.render(<Probe paneId="p1" />));
    await flush();
    expect(latest.state).toBe('ready');
    expect(latest.waitingFor).toBe(WAITING);
  });

  it('follows status events of its own pane only', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'session_chat_open' ? { available: true, reason: null, items: [], waitingFor: WAITING } : undefined,
    );
    act(() => root.render(<Probe paneId="p1" />));
    await flush();
    act(() => handlers.get('session-chat-status')!({ payload: { paneId: 'other', waitingFor: 'not mine' } }));
    expect(latest.waitingFor).toBe(WAITING);
    act(() => handlers.get('session-chat-status')!({ payload: { paneId: 'p1', waitingFor: 'Waiting for a.jsonl to be written.' } }));
    expect(latest.waitingFor).toBe('Waiting for a.jsonl to be written.');
    act(() => handlers.get('session-chat-status')!({ payload: { paneId: 'p1', waitingFor: null } }));
    expect(latest.waitingFor).toBeNull();
  });

  it('follows the source of its own pane: an API chat falls back to the screen and back', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'session_chat_open' ? { available: true, reason: null, items: [], source: 'api' } : undefined,
    );
    act(() => root.render(<Probe paneId="p1" />));
    await flush();
    expect(latest.source).toBe('api');
    act(() => handlers.get('session-chat-source')!({ payload: { paneId: 'other', source: 'screen' } }));
    expect(latest.source).toBe('api');
    act(() => handlers.get('session-chat-source')!({ payload: { paneId: 'p1', source: 'screen' } }));
    expect(latest.source).toBe('screen');
    act(() => handlers.get('session-chat-source')!({ payload: { paneId: 'p1', source: 'api' } }));
    expect(latest.source).toBe('api');
  });

  it('has no waiting line when the open answer carries none (an older backend)', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'session_chat_open' ? { available: true, reason: null, items: [] } : undefined,
    );
    act(() => root.render(<Probe paneId="p1" />));
    await flush();
    expect(latest.waitingFor).toBeNull();
  });
});

describe('useSessionChat under StrictMode', () => {
  it('ends with the reader open: the last call for the pane is an open, after the close', async () => {
    const calls: string[] = [];
    invoke.mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      return cmd === 'session_chat_open' ? { available: true, reason: null, items: [], waitingFor: WAITING } : undefined;
    });
    act(() => root.render(<StrictMode><Probe paneId="p9" /></StrictMode>));
    await flush();
    expect(calls).toEqual(['session_chat_open', 'session_chat_close', 'session_chat_open']);
    expect(latest.state).toBe('ready');
    expect(latest.waitingFor).toBe(WAITING);
  });
});

describe('useSessionChat shared reader', () => {
  const track = () => {
    const calls: Array<{ cmd: string; surface: unknown; paneId?: unknown }> = [];
    invoke.mockImplementation(async (cmd: string, args?: { surface?: unknown; paneId?: unknown }) => {
      calls.push({ cmd, surface: args?.surface, paneId: args?.paneId });
      return cmd === 'session_chat_open' ? { available: true, reason: null, items: [] } : undefined;
    });
    return calls;
  };
  function Two({ second }: { second: boolean }) {
    useSessionChat('p1', true);
    return second ? <Second /> : null;
  }
  function Second() {
    useSessionChat('p1', true);
    return null;
  }

  it('two views of one pane share one open, one set of listens, and one close when the last leaves', async () => {
    const calls = track();
    act(() => root.render(<Two second />));
    await flush();
    expect(calls.filter((c) => c.cmd === 'session_chat_open')).toHaveLength(1);
    expect(listen.mock.calls.filter((c) => c[0] === 'session-chat-items')).toHaveLength(1);
    act(() => root.render(<Two second={false} />));
    await flush();
    expect(calls.filter((c) => c.cmd === 'session_chat_close')).toHaveLength(0);
    act(() => root.render(<div />));
    await flush();
    const open = calls.find((c) => c.cmd === 'session_chat_open')!;
    expect(calls.filter((c) => c.cmd === 'session_chat_close')).toEqual([expect.objectContaining({ cmd: 'session_chat_close', surface: open.surface })]);
  });

  it('a view that comes back inside the grace reuses the open reader and asks nothing again', async () => {
    chatTuning.graceMs = 60_000;
    try {
      const calls = track();
      act(() => root.render(<Probe paneId="p1" />));
      await flush();
      act(() => root.render(<div />));
      act(() => root.render(<Probe paneId="p1" />));
      await flush();
      expect(calls.map((c) => c.cmd)).toEqual(['session_chat_open']);
    } finally {
      chatTuning.graceMs = 0;
    }
  });

  it('a chat passed over inside the settle time never opens', async () => {
    chatTuning.settleMs = 50;
    try {
      const calls = track();
      act(() => root.render(<Probe paneId="p1" />));
      act(() => root.render(<Probe paneId="p2" />));
      act(() => root.render(<Probe paneId="p3" />));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 120));
      });
      const opened = calls.filter((c) => c.cmd === 'session_chat_open').map((c) => c.paneId);
      expect(opened).toContain('p3');
      expect(opened).not.toContain('p2');
    } finally {
      chatTuning.settleMs = 0;
    }
  });
});

describe('useSessionChat source', () => {
  it('tells a chat read from the screen from one read from a file, and treats a missing source as a file', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'session_chat_open' ? { available: true, reason: null, items: [], waitingFor: null, source: 'screen' } : undefined,
    );
    act(() => root.render(<Probe paneId="p1" />));
    await flush();
    expect(latest.source).toBe('screen');

    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'session_chat_open' ? { available: true, reason: null, items: [] } : undefined,
    );
    act(() => root.render(<Probe paneId="p2" />));
    await flush();
    expect(latest.source).toBe('file');

    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'session_chat_open' ? { available: false, reason: 'no', items: [], source: null } : undefined,
    );
    act(() => root.render(<Probe paneId="p3" />));
    await flush();
    expect(latest.state).toBe('unavailable');
    expect(latest.source).toBeNull();
  });

  it('puts a reply that is sent again under the same id in place of the old copy, keeping the order', async () => {
    const reply = (text: string) => ({ kind: 'assistant', id: 'screen:1:reply', at: null, text, model: null, finalAnswer: false });
    const user = { kind: 'user', id: 'screen:1:user', at: null, text: 'say hi' };
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'session_chat_open' ? { available: true, reason: null, items: [user, reply('hi')], source: 'screen' } : undefined,
    );
    act(() => root.render(<Probe paneId="p1" />));
    await flush();
    act(() => handlers.get('session-chat-items')!({ payload: { paneId: 'p1', items: [reply('hi there')], reset: false } }));
    act(() => handlers.get('session-chat-items')!({ payload: { paneId: 'p1', items: [reply('hi there, friend')], reset: false } }));
    expect(latest.turns).toHaveLength(1);
    expect(latest.turns[0].user?.text).toBe('say hi');
    expect(latest.turns[0].steps).toHaveLength(1);
    const step = latest.turns[0].steps[0];
    expect(step.kind === 'text' && step.item.text).toBe('hi there, friend');
    // An item that went away is a reset with what is left.
    act(() => handlers.get('session-chat-items')!({ payload: { paneId: 'p1', items: [user], reset: true } }));
    expect(latest.turns[0].steps).toHaveLength(0);
  });
});

describe('useSessionChat timing marks', () => {
  // jsdom's performance has no mark buffer, so a small recording stand-in takes its place for these tests.
  type Entry = { name: string; entryType: 'mark' | 'measure'; startTime: number; duration: number };
  let entries: Entry[];
  const fakePerformance = {
    now: () => 0,
    mark: (name: string) => {
      entries.push({ name, entryType: 'mark', startTime: 0, duration: 0 });
    },
    measure: (name: string) => {
      const m = { name, entryType: 'measure' as const, startTime: 0, duration: 1 };
      entries.push(m);
      return m;
    },
    getEntriesByType: (type: string) => entries.filter((e) => e.entryType === type),
    getEntriesByName: (name: string, type?: string) => entries.filter((e) => e.name === name && (!type || e.entryType === type)),
    clearMarks: (name?: string) => {
      entries = entries.filter((e) => e.entryType !== 'mark' || (name !== undefined && e.name !== name));
    },
    clearMeasures: (name?: string) => {
      entries = entries.filter((e) => e.entryType !== 'measure' || (name !== undefined && e.name !== name));
    },
  };
  const chatMarks = () => entries.filter((entry) => entry.entryType === 'mark' && entry.name.startsWith('chat:'));
  const batch = (i: number, paneId = 'p1') => ({
    paneId,
    items: [{ kind: 'assistant', id: `screen:${i}:reply`, at: null, text: `batch ${i}`, model: null, finalAnswer: false }],
    reset: false,
  });

  beforeEach(() => {
    entries = [];
    vi.stubGlobal('performance', fakePerformance);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the chat marks to the fixed opening stages across 50 item batches', async () => {
    // The open never answers here, so the chat stays in its opening stage while the batches arrive.
    invoke.mockImplementation(async (cmd: string) => (cmd === 'session_chat_open' ? new Promise(() => undefined) : undefined));
    act(() => root.render(<Probe paneId="p1" />));
    await flush();
    for (let i = 0; i < 50; i++) {
      act(() => handlers.get('session-chat-items')!({ payload: batch(i) }));
    }
    expect(chatMarks().length).toBeLessThanOrEqual(CHAT_OPEN_STAGES.length);
    expect(chatMarks().map((entry) => entry.name)).toEqual(['chat:view:open', 'chat:view:items']);
  });

  it('measures the open and clears its marks once the snapshot lands', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'session_chat_open' ? { available: true, reason: null, items: [] } : undefined,
    );
    act(() => root.render(<Probe paneId="p2" />));
    // The snapshot has landed once the chat reports ready; only then is the open finished.
    await vi.waitFor(async () => {
      await flush();
      expect(latest.state).toBe('ready');
    });
    act(() => handlers.get('session-chat-items')!({ payload: batch(1, 'p2') }));
    expect(chatMarks()).toEqual([]);
  });
});
