// @vitest-environment jsdom
// Closing an agent: no "Are you sure?" here (an idle agent), and the undo bar brings it back for 8 seconds.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentUndo, resetUndoBar, runUndo } from '../lib/undo-bar';
import { useCockpit, type CockpitApi } from './useCockpit';

const h = vi.hoisted(() => ({
  panes: [] as { info: Record<string, unknown>; status: string }[],
  killPane: vi.fn(async (_id: string) => undefined),
  reopen: vi.fn(async (id: string) => id),
  calls: [] as { name: string; args: unknown[] }[],
}));

vi.mock('./usePaneRegistry', () => ({
  usePaneRegistry: () => ({
    panes: new Map(h.panes.map((p) => [p.info.id as string, p])),
    paneList: h.panes,
    initialReady: true,
    killPane: h.killPane,
    refresh: async () => undefined,
  }),
}));
vi.mock('../lib/agentRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/agentRegistry')>()),
  useAgentRegistry: () => ({ agents: [], dispatchable_ids: [] }),
}));
vi.mock('../lib/closedChats', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/closedChats')>()),
  tauriClosedChatsApi: { reopen: h.reopen },
}));
vi.mock('../lib/pane-preview', () => ({ usePanePreviews: () => ({}) }));
vi.mock('../lib/pane-activity', () => ({ usePaneActivity: () => ({}) }));
vi.mock('./useBridge', () => ({ useBridge: () => ({ isReady: false, error: null, client: null }) }));
vi.mock('./useQuestions', () => ({ useQuestions: () => ({ questions: [], pending: 0 }) }));
vi.mock('../lib/showTerminals', () => ({ useShowTerminals: () => true }));
vi.mock('../lib/settings', () => ({
  applyTheme: () => {},
  loadSettings: () => Promise.resolve({}),
  patchSettings: () => Promise.resolve(),
}));
vi.mock('../lib/settings-sync', () => ({ subscribeSettingsTheme: () => () => {} }));
vi.mock('../lib/tauri', () => ({ tauri: { standbyGetStatus: () => Promise.resolve(null) } }));
vi.mock('../lib/cockpit-api', () => ({
  cockpitApi: new Proxy(
    {},
    {
      get: (_t, name: string) =>
        name.startsWith('on')
          ? () => Promise.resolve(() => {})
          : (...args: unknown[]) => {
              h.calls.push({ name, args });
              return Promise.resolve(name === 'newPane' ? 'new-pane' : null);
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
  h.panes = [
    { info: { id: 'chat1', agent_type: 'claude', cwd: '/proj', lane: 'acp' }, status: 'idle' },
    { info: { id: 'term1', agent_type: 'codex', cwd: '/proj2' }, status: 'idle' },
  ];
  h.killPane.mockClear();
  h.reopen.mockClear();
  h.calls = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
});
afterEach(() => {
  act(() => root.unmount());
  resetUndoBar();
  host.remove();
});

describe('closing an agent shows the undo bar', () => {
  it('a chat: closes at once, the bar says so, Undo reopens that chat', async () => {
    await act(async () => api.closePane('chat1'));
    expect(h.killPane).toHaveBeenCalledWith('chat1');
    expect(currentUndo()?.text).toMatch(/^Closed /);
    await act(async () => {
      runUndo();
    });
    expect(h.reopen).toHaveBeenCalledWith('chat1');
    expect(api.selectedId).toBe('chat1');
  });

  it('a terminal agent: Undo starts it again in the same folder, as a terminal', async () => {
    await act(async () => api.closePane('term1'));
    expect(currentUndo()?.text).toMatch(/^Closed /);
    await act(async () => {
      runUndo();
    });
    const start = h.calls.find((c) => c.name === 'newPane');
    expect(start?.args[0]).toBe('codex');
    expect(start?.args[3]).toBe('/proj2');
  });

  it('a pane that could not be closed shows no undo bar', async () => {
    h.killPane.mockRejectedValueOnce(new Error('no'));
    await act(async () => api.closePane('chat1'));
    expect(currentUndo()).toBeNull();
  });
});
