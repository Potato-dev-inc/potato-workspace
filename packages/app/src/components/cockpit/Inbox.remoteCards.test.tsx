// @vitest-environment jsdom
// A permission card of a chat that runs on another computer (over SSH) is in the window's Inbox, says where it is,
// and answering it goes through the window's answer path.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { Question } from '../../lib/questions';
import { Inbox } from './Inbox';

vi.mock('../../lib/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/accounts')>()),
  tauriAccountsApi: { list: async () => ({ agents: [], accounts: [] }) },
}));
vi.mock('../../lib/collision', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/collision')>()),
  tauriCollisionApi: { list: () => Promise.resolve([]), ignore: vi.fn(), settingsGet: vi.fn(), settingsSet: vi.fn(), onChanged: () => Promise.resolve(() => {}) },
}));
vi.mock('../../lib/ssh', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/ssh')>()),
  sshApi: { hosts: async () => [{ id: 'h1', name: 'Build box', user: 'dev', host: 'build.local', port: 22, keyFile: null, os: null, checkedAt: null, agents: [] }] },
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

// The remote chat's folder: a NUL, `ssh://`, the machine's id, then the folder there (`ssh::acp::pane_folder`).
const REMOTE_CWD = '\u0000ssh://h1/home/dev/app';

const card: Question = {
  id: 'q-remote',
  agent: 'Claude',
  pane_id: 'r1',
  question: 'Run the test suite?',
  choices: [
    { id: 'allow', label: 'Allow' },
    { id: 'deny', label: 'Deny' },
  ],
  allow_free_text: false,
  urgency: 'normal',
  created_at_ms: 0,
  expires_at_ms: 43_200_000,
  state: 'pending',
  kind: 'acp_permission',
};

function api() {
  const info = { id: 'r1', agent_type: 'claude', pid: 1, status: 'waiting_input', created_at: 1, last_output_at: null, cwd: REMOTE_CWD, cols: 80, rows: 24, title: null, account: null } as unknown as PaneInfo;
  const answerQuestion = vi.fn(async () => undefined);
  const c = {
    registry: { paneList: [{ info, status: 'waiting_input' }], panes: new Map([['r1', { info, status: 'waiting_input' }]]), initialReady: true },
    names: new Map([['r1', 'Claude']]),
    asked: { questions: [card], answerQuestion, dismissQuestion: vi.fn() },
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
    newAgent: vi.fn(),
  } as unknown as CockpitApi;
  return { c, answerQuestion };
}
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text);
const mount = async (c: CockpitApi) => {
  await act(async () => {
    root.render(<Inbox c={c} />);
  });
};

describe('Inbox: a permission card of a chat on another computer', () => {
  it('shows the card with where it is, and answering it sends the choice through the window answer', async () => {
    const { c, answerQuestion } = api();
    await mount(c);
    expect(host.textContent).toContain('Run the test suite?');
    expect(host.textContent).toContain('On Build box');
    act(() => button('Allow')!.click());
    expect(answerQuestion).toHaveBeenCalledWith('q-remote', { choice_id: 'allow' });
  });
});
