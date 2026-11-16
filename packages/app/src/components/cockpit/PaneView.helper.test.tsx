// @vitest-environment jsdom
// A helper pane's header names the pane that started it and opens it on a click.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { requestChatTab } from '../../lib/chatTab';
import { PaneView } from './PaneView';

const invoke = vi.fn(async (cmd: string) => (cmd === 'checkpoints_list' ? { state: 'ok', message: '', items: [] } : null) as unknown);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));
vi.mock('../../lib/sessionChat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/sessionChat')>()),
  openSessionChat: vi.fn(async () => ({ available: true, reason: null, items: [] })),
  closeSessionChat: vi.fn(async () => undefined),
  onSessionChatItems: vi.fn(async () => () => undefined),
  onSessionChatStatus: vi.fn(async () => () => undefined),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const mk = (id: string, title: string, parent?: string) => ({
  status: 'idle',
  info: { id, agent_type: 'claude', status: 'idle', pid: 1, created_at: 1, last_output_at: null, cwd: 'C:\work\shop', cols: 80, rows: 24, title, parent_pane_id: parent },
});

function cockpit(list: ReturnType<typeof mk>[], selected: string): CockpitApi {
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map(list.map((p) => [p.info.id, 'Claude'])),
    activities: {},
    previews: {},
    asked: { questions: [] },
    prompts: {},
    statusSince: new Map(),
    now: 12_000,
    selectedId: selected,
    mode: 'orchestration',
    select: vi.fn(),
    notify: vi.fn(),
  } as unknown as CockpitApi;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});

const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });

// These tests are about the pane, not the side panel: a window under 960 px (240 sidebar + 240 panel + 480 chat) has none.
Object.defineProperty(window, 'innerWidth', { value: 900, configurable: true });

describe('helper pane header', () => {
  it('names the parent and opens it', async () => {
    const c = cockpit([mk('p', 'Refactor auth'), mk('h', 'Check tests', 'p')], 'h');
    await act(async () => root.render(<PaneView c={c} paneId="h" />));
    await flush();
    const link = host.querySelector<HTMLButtonElement>('.ck-helper-of')!;
    expect(link.textContent).toBe('Started by Refactor auth');
    await act(async () => link.click());
    expect(c.select).toHaveBeenCalledWith('p');
  });

  it('says who started a helper and the first line of its task', async () => {
    const h = mk('h', 'Check tests');
    (h.info as Record<string, unknown>).origin = { host: 'Claude Code', task: 'Check the login tests' };
    const c = cockpit([h], 'h');
    await act(async () => root.render(<PaneView c={c} paneId="h" />));
    await flush();
    expect(host.querySelector('[data-testid="pane-started-by"]')!.textContent).toBe('Started by Claude Code: Check the login tests');
  });

  it('shows no started-by line for a pane the person opened', async () => {
    const c = cockpit([mk('p', 'Refactor auth')], 'p');
    await act(async () => root.render(<PaneView c={c} paneId="p" />));
    await flush();
    expect(host.querySelector('[data-testid="pane-started-by"]')).toBeNull();
  });

  it('shows nothing for a pane with no live parent', async () => {
    const c = cockpit([mk('p', 'Refactor auth'), mk('h', 'Check tests', 'gone')], 'h');
    await act(async () => root.render(<PaneView c={c} paneId="h" />));
    await flush();
    expect(host.querySelector('.ck-helper-of')).toBeNull();
    await act(async () => root.render(<PaneView c={c} paneId="p" />));
    await flush();
    expect(host.querySelector('.ck-helper-of')).toBeNull();
  });
});

// A minion's questions (Two types mode). The app keeps an ordinary ask from the person (the minion reads as working, so
// it has no card); a risky ask ("delete") is one card in the chat of the agent that started the minion.
describe('a minion question in its parent chat', () => {
  const del = {
    promptId: 'q-del',
    kind: 'question',
    text: 'Delete old.txt',
    summary: 'Delete old.txt',
    choices: [
      { id: 'allow', label: 'Allow once' },
      { id: 'no', label: 'Reject' },
    ],
  };
  const minion = (status: string) => ({ ...mk('m', 'Check tests', 'p'), status, info: { ...mk('m', 'Check tests', 'p').info, status, started_as: 'minion' } });
  const render = async (status: string, withPrompt: boolean) => {
    const c = cockpit([mk('p', 'Refactor auth'), minion(status)], 'p');
    (c as unknown as { prompts: unknown }).prompts = withPrompt ? { m: del } : {};
    requestChatTab('p');
    await act(async () => root.render(<PaneView c={c} paneId="p" />));
    await flush();
  };

  it('an ordinary ask raises no card: the minion reads as working', async () => {
    await render('running', false);
    expect(host.querySelector('.ck-helper-asks')).toBeNull();
  });

  it('a risky ask of a chat-session minion ("delete") is one card in the parent chat, answered through the question store', async () => {
    const answerQuestion = vi.fn(async () => undefined);
    const q = {
      id: 'q1',
      pane_id: 'm',
      agent: 'Claude',
      kind: 'acp_permission',
      question: 'A minion (Claude) wants to: Delete old.txt',
      choices: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
      allow_free_text: false,
      urgency: 'high',
      created_at_ms: 1,
      expires_at_ms: 99,
      state: 'pending',
    };
    const c = cockpit([mk('p', 'Refactor auth'), minion('waiting_input')], 'p');
    (c as unknown as { asked: unknown }).asked = { questions: [q], answerQuestion, dismissQuestion: vi.fn() };
    requestChatTab('p');
    await act(async () => root.render(<PaneView c={c} paneId="p" />));
    await flush();
    expect(host.querySelectorAll('.ck-helper-asks .ib-dock')).toHaveLength(1);
    expect(host.querySelector('.ck-helper-asks-lead')?.textContent).toBe('A minion of Claude asks');
    expect(host.querySelector('.ck-helper-asks .ib-title')?.textContent).toContain('A minion (Claude) wants to: Delete old.txt');
    const yes = [...host.querySelectorAll<HTMLButtonElement>('.ck-helper-asks [data-ib="answer"]')].find((b) => b.textContent === 'Yes')!;
    await act(async () => yes.click());
    expect(answerQuestion).toHaveBeenCalledWith('q1', { choice_id: 'yes' });
  });

  it('a risky ask ("delete") is one card in the parent chat that names whose minion it is', async () => {
    await render('waiting_input', true);
    expect(host.querySelectorAll('.ck-helper-asks .ib-dock')).toHaveLength(1);
    expect(host.querySelector('.ck-helper-asks .ib-title')?.textContent).toBe('A minion of Claude asks: Delete old.txt');
    expect(host.querySelector('.ck-helper-asks [data-ib="open"]')?.textContent).toBe('See what it is doing');
  });
});
