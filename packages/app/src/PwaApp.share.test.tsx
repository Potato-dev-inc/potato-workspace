// @vitest-environment jsdom
// Share to Potato from any phone app: what the Share menu handed over (text, a link, a picture) opens "New chat with this" in
// the whole phone app, the words are in the box, the picture is a chip, and nothing is sent until the person presses Send.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  claim: vi.fn(),
  terminalMounts: 0,
  terminalUnmounts: 0,
  paneChat: vi.fn(),
  acpSession: vi.fn(),
  acpCancel: vi.fn(),
  questions: [] as unknown[],
  answerQuestion: vi.fn(),
  panes: [] as unknown[],
  caps: ['watch', 'answer', 'type', 'control'],
  phoneNewChat: vi.fn(),
  uploadPaneFile: vi.fn(),
  phoneStartChat: vi.fn(),
  sendPaneMessage: vi.fn(),
  acpSetConfig: vi.fn(),
  acpClosed: vi.fn(),
  acpReopen: vi.fn(),
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
    attention: async () => ({ v: 1, rev: 1, counts: { blocking: 0, ready: 0 }, items: [] }),
    pairMe: async () => ({ local: false, caps: h.caps }),
    paneChat: h.paneChat,
    acpSession: h.acpSession,
    acpCancel: h.acpCancel,
    listQuestions: async () => h.questions,
    answerQuestion: h.answerQuestion,
    dismissQuestion: vi.fn(),
    phoneNewChat: h.phoneNewChat,
    uploadPaneFile: h.uploadPaneFile,
    phoneStartChat: h.phoneStartChat,
    sendPaneMessage: h.sendPaneMessage,
    acpSetConfig: h.acpSetConfig,
    acpClosed: h.acpClosed,
    acpReopen: h.acpReopen,
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
import { shareFromForm, writeShare, type ShareCaches } from './pwa/share-target';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pane = (id: string) => ({ id, agent_type: 'codex', status: 'idle', created_at: 1, cwd: 'C:/x', pid: 0, last_output_at: null, cols: 80, rows: 24, lane: 'acp' });

/** A fake Cache Storage the service worker's share lands in. */
function fakeCaches(): ShareCaches {
  const store = new Map<string, Map<string, Response>>();
  return {
    async open(name) {
      const cache = store.get(name) ?? new Map<string, Response>();
      store.set(name, cache);
      return {
        put: async (key, response) => void cache.set(key, response),
        match: async (key) => cache.get(key)?.clone(),
        delete: async (key) => cache.delete(key),
      };
    },
  };
}

async function shareArrives(fields: Record<string, string>, files: File[] = []) {
  const caches = fakeCaches();
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  for (const file of files) form.append('media', file);
  await writeShare(caches, shareFromForm(form), Date.now());
  vi.stubGlobal('caches', caches);
  window.history.replaceState(null, '', '/?share=1');
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  setLanguagePref('en', false);
  localStorage.clear();
  localStorage.setItem('pm.bridge.url', 'http://phone.test');
  localStorage.setItem('pm.mobile.activeTab', 'c1');
  h.caps = ['watch', 'answer', 'type', 'control'];
  h.panes = [pane('c1')];
  h.questions = [];
  h.paneChat.mockReset();
  h.paneChat.mockResolvedValue({ available: true, reason: null, source: 'acp', waitingFor: null, rev: 1, reset: false, items: [] });
  h.acpSession.mockReset();
  h.acpSession.mockResolvedValue({ lane: 'acp', agent: 'codex', label: 'Codex', phase: 'idle', status: 'idle', turnInFlight: false, stopping: false, canSteer: false, turn: 1, title: null, usage: null, permissions: [], closed: false });
  h.phoneNewChat.mockReset();
  h.phoneNewChat.mockResolvedValue({
    agents: [{ id: 'codex', label: 'Codex', chat: true, terminal: false }],
    projects: [{ id: 'p1', name: 'shop', state: 'repo' }],
    terminals: false,
  });
  h.phoneStartChat.mockReset();
  h.phoneStartChat.mockResolvedValue({ pane_id: 'c1', agent: 'codex', lane: 'chat' });
  h.sendPaneMessage.mockReset();
  h.sendPaneMessage.mockResolvedValue({ id: 'm1', text: 'x', state: 'queued', created_at: 1 });
  h.uploadPaneFile.mockReset();
  h.uploadPaneFile.mockImplementation(async (_pane: string, body: { name: string; mime: string }) => ({ name: body.name, path: `C:/uploads/${body.name}`, kind: 'image', size: 4, mime: body.mime }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const flush = (ms = 50) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const mount = async () => {
  await act(async () => {
    root.render(<PwaApp />);
    await vi.advanceTimersByTimeAsync(50);
  });
  await flush();
};
const screen = () => host.querySelector('[data-testid="phone-new-chat"]');
const box = () => screen()!.querySelector('textarea') as HTMLTextAreaElement;
const send = () =>
  act(async () => {
    (screen()!.querySelector('button[type="submit"]') as HTMLElement).click();
    // Reading a picture (FileReader) and the calls to the PC take a few timer turns.
    for (let turn = 0; turn < 10; turn += 1) await vi.advanceTimersByTimeAsync(30);
  });
const photo = () => new File([new Uint8Array([1, 2, 3, 4])], 'screenshot.png', { type: 'image/png' });

describe('share to Potato from a phone app', () => {
  it('opens "New chat with this" with the shared words in the box, and sends nothing by itself', async () => {
    await shareArrives({ title: 'A page', text: 'see this', url: 'https://example.com/a' });
    await mount();
    expect(screen()).not.toBeNull();
    expect(screen()!.querySelector('h1')?.textContent).toBe('New chat with this');
    expect(screen()!.textContent).toContain('Nothing is sent until you press Send.');
    expect(box().value).toBe('A page\nsee this\nhttps://example.com/a');
    expect(screen()!.querySelector('[data-testid="nc-agent-tile"][aria-checked="true"]')?.textContent).toContain('Codex');
    expect(screen()!.querySelector('[data-testid="nc-project-pill"]')?.textContent).toContain('Project: shop');
    expect(window.location.search).toBe('');
    expect(h.phoneStartChat).not.toHaveBeenCalled();
    expect(h.sendPaneMessage).not.toHaveBeenCalled();
  });

  it('Send starts the chat with the shared words as the first message', async () => {
    await shareArrives({ text: 'Great read https://example.com/a' });
    await mount();
    await send();
    expect(h.phoneStartChat).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex', project: 'p1', lane: 'chat' }));
    expect(h.sendPaneMessage).toHaveBeenCalledWith('c1', 'Great read https://example.com/a');
    expect(screen()).toBeNull();
  });

  it('a shared picture is a chip in the box; it goes to the new chat only on Send, with the message', async () => {
    await shareArrives({ text: 'what is wrong here?' }, [photo()]);
    await mount();
    const chips = screen()!.querySelector('[data-testid="phone-attach-chips"]');
    expect(chips?.textContent).toContain('screenshot.png');
    expect(h.uploadPaneFile).not.toHaveBeenCalled();
    expect(h.phoneStartChat).not.toHaveBeenCalled();
    await send();
    expect(h.uploadPaneFile).toHaveBeenCalledWith('c1', expect.objectContaining({ name: 'screenshot.png', mime: 'image/png' }));
    expect(h.sendPaneMessage).toHaveBeenCalledWith('c1', 'what is wrong here?', [expect.objectContaining({ path: 'C:/uploads/screenshot.png' })]);
  });

  it('a picture that cannot go keeps the message back; the chat is open and says so', async () => {
    h.uploadPaneFile.mockRejectedValue(new Error('bridge POST /panes/c1/uploads -> 403: no'));
    await shareArrives({ text: 'look' }, [photo()]);
    await mount();
    await send();
    expect(h.phoneStartChat).toHaveBeenCalledTimes(1);
    expect(h.sendPaneMessage).not.toHaveBeenCalled();
    expect(host.textContent).toContain('the first message did not go');
  });

  it('closing it throws the shared words away: the next plain new chat starts empty', async () => {
    await shareArrives({ text: 'private note' });
    await mount();
    await act(async () => {
      (screen()!.querySelector('button[aria-label="Close"]') as HTMLElement).click();
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(screen()).toBeNull();
    await act(async () => {
      (host.querySelector('[aria-label="New chat"]') as HTMLElement).click();
      await vi.advanceTimersByTimeAsync(20);
    });
    await flush();
    expect(screen()!.querySelector('h1')?.textContent).toBe('New chat');
    expect(box().value).toBe('');
    expect(h.phoneStartChat).not.toHaveBeenCalled();
  });

  it('a phone without the control ability sees the share but cannot send it', async () => {
    h.caps = ['watch', 'answer', 'type'];
    await shareArrives({ text: 'hello' });
    await mount();
    expect(screen()!.textContent).toContain('This phone may not start chats.');
    expect(box().disabled).toBe(true);
    expect(h.phoneStartChat).not.toHaveBeenCalled();
  });

  it('with no share the app opens as before, and an empty ?share=1 opens nothing', async () => {
    await mount();
    expect(screen()).toBeNull();
    vi.stubGlobal('caches', fakeCaches());
    window.history.replaceState(null, '', '/?share=1');
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    expect(screen()).toBeNull();
  });

  it('says its words in Traditional Chinese too', async () => {
    setLanguagePref('zh-TW', false);
    await shareArrives({ text: 'hi' });
    await mount();
    expect(screen()!.querySelector('h1')?.textContent).toBe('用這個開新對話');
    setLanguagePref('en', false);
  });
});
