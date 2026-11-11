// @vitest-environment jsdom
// A usage-limit card in the Inbox offers the agent's other sign-ins and starts the same agent under the one picked.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { Question } from '../../lib/questions';
import { Inbox } from './Inbox';

vi.mock('../../lib/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/accounts')>()),
  tauriAccountsApi: {
    list: async () => ({
      agents: [],
      accounts: [
        { id: 'acc_work', agent_id: 'claude', label: 'Work', home: '' },
        { id: 'acc_home', agent_id: 'claude', label: 'Personal', home: '' },
        { id: 'acc_codex', agent_id: 'codex', label: 'Team seat', home: '' },
      ],
    }),
  },
}));
vi.mock('../../lib/collision', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/collision')>()),
  tauriCollisionApi: { list: () => Promise.resolve([]), ignore: vi.fn(), settingsGet: vi.fn(), settingsSet: vi.fn(), onChanged: () => Promise.resolve(() => {}) },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (Element.prototype as { scrollIntoView?: () => void }).scrollIntoView = () => {};
  window.localStorage.setItem('pm.cockpit.everSpawned', '1');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.localStorage.clear();
});

const limit: Question = {
  id: 'l1',
  agent: 'Claude',
  pane_id: 'p1',
  question: 'Claude ran out of usage.',
  context: 'It can continue later.',
  choices: [{ id: 'continue:codex', label: 'Continue on Codex' }, { id: 'stop', label: 'Stop here' }],
  allow_free_text: false,
  urgency: 'high',
  created_at_ms: 0,
  expires_at_ms: 43_200_000,
  state: 'pending',
  limit: { kind: 'usage_limit', agent_label: 'Claude', window: 'session limit', reset_at_ms: 1, has_run: true },
};

function api(account: string | null) {
  const info = { id: 'p1', agent_type: 'claude', pid: 1, status: 'idle', created_at: 1, last_output_at: null, cwd: 'C:/shop', cols: 80, rows: 24, title: null, account } as unknown as PaneInfo;
  const newAgent = vi.fn();
  const c = {
    registry: { paneList: [{ info, status: 'idle' }], panes: new Map([['p1', { info, status: 'idle' }]]), initialReady: true },
    names: new Map([['p1', 'Claude']]),
    asked: { questions: [limit], answerQuestion: vi.fn(), dismissQuestion: vi.fn() },
    launchEntries: [],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select: vi.fn(),
    prompts: {},
    statusSince: new Map(),
    now: 120_000,
    spawn: null,
    answer: vi.fn(),
    interrupt: vi.fn(),
    newAgent,
  } as unknown as CockpitApi;
  return { c, newAgent };
}
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text);
const mount = async (c: CockpitApi) => {
  await act(async () => {
    root.render(<Inbox c={c} />);
  });
};

describe('Inbox: a usage-limit card and the other sign-ins', () => {
  it('lists the other sign-ins of the same agent only, and starts the one picked in the same folder', async () => {
    const { c, newAgent } = api(null);
    await mount(c);
    act(() => button('Use another sign-in')!.click());
    expect(button('Team seat')).toBeUndefined();
    act(() => button('Personal')!.click());
    expect(newAgent).toHaveBeenCalledWith('claude', 'acc_home', false, 'C:/shop');
  });

  it('a pane that runs under one sign-in is offered the others and the default', async () => {
    const { c, newAgent } = api('acc_work');
    await mount(c);
    act(() => button('Use another sign-in')!.click());
    expect(button('Work')).toBeUndefined();
    act(() => button('Default sign-in')!.click());
    expect(newAgent).toHaveBeenCalledWith('claude', undefined, false, 'C:/shop');
  });
});
