// @vitest-environment jsdom
// The cockpit's `newAgent` with "Show terminals" OFF starts a chat (the palette, board, inbox and the other callers all use
// it); an agent with no chat, or a sign-in terminal (`how: 'terminal'`), still opens a terminal. With terminals shown it is the
// terminal as before.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forceShowTerminals } from '../lib/showTerminals';
import { useCockpit, type CockpitApi } from './useCockpit';

const h = vi.hoisted(() => ({
  newPane: vi.fn(async () => 'term-1'),
  startChatFirst: vi.fn(),
}));

vi.mock('./usePaneRegistry', () => ({
  usePaneRegistry: () => ({ panes: new Map(), paneList: [], initialReady: true }),
}));
vi.mock('../lib/agentRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/agentRegistry')>()),
  useAgentRegistry: () => ({ agents: [], dispatchable_ids: [] }),
}));
vi.mock('../lib/pane-preview', () => ({ usePanePreviews: () => ({}) }));
vi.mock('../lib/pane-activity', () => ({ usePaneActivity: () => ({}) }));
vi.mock('./useBridge', () => ({ useBridge: () => ({ isReady: false, error: null, client: null }) }));
vi.mock('./useQuestions', () => ({ useQuestions: () => ({ questions: [], pending: 0 }) }));
vi.mock('../lib/settings', () => ({ applyTheme: () => {}, loadSettings: () => Promise.resolve({}), patchSettings: () => Promise.resolve() }));
vi.mock('../lib/settings-sync', () => ({ subscribeSettingsTheme: () => () => {} }));
vi.mock('../lib/tauri', () => ({ tauri: { standbyGetStatus: () => Promise.resolve(null) } }));
vi.mock('../lib/chatFirst', () => ({ realChatFirstDeps: () => ({}), startChatFirst: (...a: unknown[]) => h.startChatFirst(...a) }));
vi.mock('../lib/cockpit-api', () => ({
  cockpitApi: new Proxy(
    {},
    {
      get: (_t, name: string) => {
        if (name === 'newPane') return (...a: unknown[]) => (h.newPane as unknown as (...x: unknown[]) => unknown)(...a);
        return name.startsWith('on') ? () => Promise.resolve(() => {}) : () => Promise.resolve(null);
      },
    },
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let api: CockpitApi;
function Probe() {
  api = useCockpit();
  return null;
}

beforeEach(async () => {
  h.newPane.mockClear();
  h.startChatFirst.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
});
afterEach(() => {
  forceShowTerminals(true);
  act(() => root.unmount());
  host.remove();
});

describe('newAgent with terminals hidden', () => {
  it('starts a chat in the named folder and selects it', async () => {
    await act(async () => forceShowTerminals(false));
    h.startChatFirst.mockResolvedValue({ kind: 'started', paneId: 'chat-1' });
    await act(async () => {
      await api.newAgent('claude', undefined, false, '/work/a', 'm1');
    });
    expect(h.startChatFirst).toHaveBeenCalledWith({ agentId: 'claude', accountId: undefined, folder: '/work/a', model: 'm1' }, expect.anything());
    expect(h.newPane).not.toHaveBeenCalled();
    expect(api.selectedId).toBe('chat-1');
  });

  it('with no folder the default folder is used (the folder is left empty for the backend to fill)', async () => {
    await act(async () => forceShowTerminals(false));
    h.startChatFirst.mockResolvedValue({ kind: 'started', paneId: 'chat-2' });
    await act(async () => {
      await api.newAgent('codex');
    });
    expect(h.startChatFirst.mock.calls[0][0]).toMatchObject({ agentId: 'codex', folder: undefined });
  });

  it('a chat that could not start says why and starts no terminal', async () => {
    await act(async () => forceShowTerminals(false));
    h.startChatFirst.mockResolvedValue({ kind: 'failed', sentence: 'The agent did not answer.' });
    let id: string | null = 'x';
    await act(async () => {
      id = await api.newAgent('claude');
    });
    expect(id).toBeNull();
    expect(h.newPane).not.toHaveBeenCalled();
  });

  it('an agent with no chat is opened the way it was before, in a terminal', async () => {
    await act(async () => forceShowTerminals(false));
    h.startChatFirst.mockResolvedValue({ kind: 'no-chat' });
    await act(async () => {
      await api.newAgent('aider', undefined, false, '/work/a');
    });
    expect(h.newPane).toHaveBeenCalledTimes(1);
  });

  it('a sign-in terminal (how = terminal) never tries a chat', async () => {
    await act(async () => forceShowTerminals(false));
    await act(async () => {
      await api.newAgent('claude', undefined, false, '/work/a', undefined, 'terminal');
    });
    expect(h.startChatFirst).not.toHaveBeenCalled();
    expect(h.newPane).toHaveBeenCalledTimes(1);
  });

  it('with terminals shown it is the terminal, as before', async () => {
    await act(async () => forceShowTerminals(true));
    await act(async () => {
      await api.newAgent('claude', undefined, false, '/work/a');
    });
    expect(h.startChatFirst).not.toHaveBeenCalled();
    expect(h.newPane).toHaveBeenCalledTimes(1);
  });
});
