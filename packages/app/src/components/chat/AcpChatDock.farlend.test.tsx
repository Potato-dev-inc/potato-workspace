// @vitest-environment jsdom
// A far chat on that PC's own signed-out login, while this PC has an active lend of that agent to it: the sign-in card offers "Switch to the
// borrowed sign-in", which starts a new chat in the same project there (it takes the lend) and keeps the waiting words.
import { paneOf } from '../../lib/host/farCockpit';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { GRANT_OUT, lendState } from '../../dev/lend-fixtures';
import type { AcpChatState } from '../../lib/acpChat';
import { fakeAcpApi } from '../../lib/acpChatFake';
import type { Grant } from '../../lib/lend';

let grants: Grant[] = [];
vi.mock('../lend/useLend', () => ({
  useLend: () => ({ state: lendState({ grants }), enabled: true, known: true, now: Date.now(), refresh: () => undefined }),
}));
const inserted = vi.fn();
vi.mock('../../lib/composer-insert', () => ({ pushComposerInsert: (...a: unknown[]) => inserted(...a) }));

import { AcpChatDock } from './AcpChatDock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = 'dev:bbbb:p1';
const out = (over: Partial<Grant> = {}): Grant => ({ ...GRANT_OUT, agent_id: 'claude', peer_node: 'bbbb', ends_ms: Date.now() + 3600_000, ...over });
const signedOut = { lane: 'acp', agent: 'claude', label: 'Claude', phase: 'idle', status: 'idle', turnInFlight: false, stopping: false, canSteer: false, turn: 1, title: null, usage: null, permissions: [], closed: false, signIn: { needed: true, hint: '', text: 'fix the tests' } } as unknown as AcpChatState;

let host: HTMLDivElement;
let root: Root;
const select = vi.fn();
const c = { now: 5, asked: { questions: [], answerQuestion: vi.fn(), dismissQuestion: vi.fn() }, newAgent: vi.fn(), select, launchEntries: [], registry: { panes: new Map([[KEY, { info: paneOf('bbbb', 'pm-sandbox', { key: KEY, paneId: 'p1', title: '', agent: 'claude', status: 'idle', cwd: 'work-test', chat: true, project: 'p1a2b3c4d5e6f7a8' }).info }]]) } } as unknown as CockpitApi;
beforeEach(() => {
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
  grants = [];
  inserted.mockClear();
  select.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const button = () => host.querySelector<HTMLButtonElement>('[data-testid="signin-use-lend"]');
async function mount(start = vi.fn(async () => ({ pane_id: 'dev:bbbb:p2', agent: 'claude', lane: 'acp' as const }))) {
  await act(async () => root.render(<AcpChatDock c={c} paneId={KEY} paneName="Claude" api={fakeAcpApi({ state: async () => signedOut, start })} />));
  await act(async () => {});
  return start;
}

describe('a far chat that needs a sign-in', () => {
  it('offers the borrowed sign-in when this PC has an active lend of the agent to that PC, and starts a new chat on it', async () => {
    grants = [out()];
    const start = await mount();
    expect(button()?.textContent).toBe('Switch to the borrowed sign-in');
    await act(async () => button()!.click());
    expect(start).toHaveBeenCalledWith('claude', 'p1a2b3c4d5e6f7a8', true, undefined, undefined);
    expect(select).toHaveBeenCalledWith('dev:bbbb:p2');
    expect(inserted).toHaveBeenCalledWith('dev:bbbb:p2', 'fix the tests');
  });

  it('a chat that worked on a copy starts from its project and asks for a copy again; a refusal says who said no', async () => {
    grants = [out({ peer_device_name: 'pm-sandbox' })];
    const copyKey = 'dev:bbbb:p3';
    (c.registry.panes as Map<string, unknown>).set(copyKey, { info: paneOf('bbbb', 'pm-sandbox', { key: copyKey, paneId: 'p3', title: '', agent: 'claude', status: 'idle', cwd: 'work-test', chat: true, copy: true, project: 'p1a2b3c4d5e6f7a8' }).info });
    const refuse = vi.fn(async () => {
      throw new Error('This PC does not know that project. Open it here first.');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await act(async () => root.render(<AcpChatDock c={c} paneId={copyKey} paneName="Claude" api={fakeAcpApi({ state: async () => signedOut, start: refuse })} />));
    await act(async () => {});
    await act(async () => button()!.click());
    expect(refuse).toHaveBeenCalledWith('claude', 'p1a2b3c4d5e6f7a8', true, undefined, true);
    expect(host.textContent).toContain('pm-sandbox said no: This PC does not know that project.');
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('offers nothing without such a lend (another PC, another agent, or a lend that is over)', async () => {
    for (const list of [[], [out({ peer_node: 'cccc' })], [out({ agent_id: 'codex' })], [out({ ends_ms: Date.now() - 1 })], [out({ state: 'ended' })]]) {
      grants = list;
      await mount();
      expect(button()).toBeNull();
    }
  });
});
