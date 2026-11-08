// @vitest-environment jsdom
// The dock of a chat session over ACP: the agent's permission questions as cards with its own options, and the strip with
// Stop that reads "Stopping…" until the turn ends.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { AcpChatApi, AcpChatState } from '../../lib/acpChat';
import { fakeAcpApi } from '../../lib/acpChatFake';
import type { Question } from '../../lib/questions';
import { AcpChatDock } from './AcpChatDock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const question = (over: Partial<Question> = {}): Question => ({
  id: 'q1',
  question: 'Codex asks permission: Write notes.txt',
  choices: [
    { id: 'allow_once', label: 'Allow Once' },
    { id: 'allow_always', label: 'Allow for Session' },
    { id: 'reject_once', label: 'Reject' },
  ],
  allow_free_text: false,
  urgency: 'high',
  created_at_ms: 1,
  expires_at_ms: 99,
  state: 'pending',
  kind: 'acp_permission',
  pane_id: 'p1',
  ...over,
});

const state = (over: Partial<AcpChatState> = {}): AcpChatState => ({
  lane: 'acp',
  agent: 'codex',
  label: 'Codex',
  phase: 'working',
  status: 'running',
  turnInFlight: true,
  stopping: false,
  canSteer: false,
  turn: 1,
  title: null,
  usage: null,
  permissions: [],
  closed: false,
  ...over,
});

function cockpit(questions: Question[]) {
  const answerQuestion = vi.fn(async () => undefined);
  const dismissQuestion = vi.fn(async () => undefined);
  const c = { now: 5, asked: { questions, answerQuestion, dismissQuestion } } as unknown as CockpitApi;
  return { c, answerQuestion, dismissQuestion };
}

function fakeApi(initial: AcpChatState | null, over: Partial<AcpChatApi> = {}) {
  let push: ((paneId: string, next: AcpChatState) => void) | null = null;
  const cancel = vi.fn(async () => true);
  const api: AcpChatApi = fakeAcpApi({
    ...over,
    state: async () => initial,
    cancel,
    watch: async (cb) => {
      push = cb;
      return () => {
        push = null;
      };
    },
  });
  return { api, cancel, emit: (next: AcpChatState) => act(async () => push?.('p1', next)) };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('button')];
const button = (text: string) => buttons().find((b) => b.textContent === text);

describe('AcpChatDock', () => {
  it('a chat whose adapter crashed says why, shows no spinner, and Restart chat brings it back', async () => {
    const { c } = cockpit([]);
    const restart = vi.fn(async () => state({ phase: 'idle', status: 'idle', turnInFlight: false }));
    const { api } = fakeApi(state({ phase: 'exited', status: 'error', turnInFlight: false, exit: { kind: 'crashed', code: 3, reason: null } }), { restart });
    await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
    await flush();
    expect(host.querySelector('[data-testid="acp-strip"]')).toBeNull();
    expect(host.querySelector('[data-testid="acp-stopped"]')?.textContent).toContain('The chat stopped: the agent stopped unexpectedly (exit code 3)');
    await act(async () => button('Restart chat')!.click());
    expect(restart).toHaveBeenCalledWith('p1');
  });

  it('a restart that fails keeps the line and says why', async () => {
    const { c } = cockpit([]);
    const restart = vi.fn(async () => {
      throw new Error('ACP_START_FAILED: The chat could not restart: the adapter closed the connection');
    });
    const { api } = fakeApi(state({ phase: 'exited', turnInFlight: false, exit: { kind: 'start_failed', code: null, reason: 'no such file' } }), { restart });
    await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
    await flush();
    await act(async () => button('Restart chat')!.click());
    await flush();
    const line = host.querySelector('[data-testid="acp-stopped"]')?.textContent ?? '';
    expect(line).toContain('The chat stopped: the agent could not start: no such file');
    expect(line).toContain('the adapter closed the connection');
    expect(button('Retry')?.disabled).toBe(false);
  });

  it('a turn the app did not see end says so, and Continue (the person clicks) sends one message', async () => {
    const { c } = cockpit([]);
    const continueTurn = vi.fn(async () => undefined);
    const { api } = fakeApi(state({ phase: 'dormant', status: 'idle', turnInFlight: false, interruptedTurn: true }), { continueTurn });
    await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
    await flush();
    expect(host.querySelector('[data-testid="acp-interrupted"]')?.textContent).toContain('The app closed during this turn.');
    expect(continueTurn).not.toHaveBeenCalled();
    await act(async () => button('Continue')!.click());
    expect(continueTurn).toHaveBeenCalledWith('p1');
  });

  it('a quiet agent asks "No answer for 5 min" with Stop and Keep waiting, and each button does its own thing', async () => {
    const { c } = cockpit([]);
    const keepWaiting = vi.fn(async () => true);
    const { api, cancel } = fakeApi(state({ quietSecs: 300 }), { keepWaiting });
    await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
    await flush();
    expect(host.querySelector('[data-testid="acp-quiet"]')?.textContent).toContain('No answer for 5 min');
    expect(host.querySelector('[data-testid="acp-strip"]')).toBeNull();
    await act(async () => button('Keep waiting')!.click());
    expect(keepWaiting).toHaveBeenCalledWith('p1');
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => button('Stop')!.click());
    expect(cancel).toHaveBeenCalledWith('p1');
    // Stopping now: the question is gone; "Stopping…" is the message box's to say (see AcpRunStop.test.tsx).
    expect(host.querySelector('[data-testid="acp-quiet"]')).toBeNull();
    expect(host.querySelector('[data-testid="acp-strip"]')).toBeNull();
  });

  it('the question goes away when the agent speaks again (the state drops quietSecs)', async () => {
    const { c } = cockpit([]);
    const { api, emit } = fakeApi(state({ quietSecs: 300 }));
    await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
    await flush();
    expect(host.querySelector('[data-testid="acp-quiet"]')).not.toBeNull();
    await emit(state({ quietSecs: null }));
    expect(host.querySelector('[data-testid="acp-quiet"]')).toBeNull();
    expect(host.querySelector('[data-testid="acp-strip"]')).toBeNull();
    expect(host.querySelector('[data-testid="acp-dock"]')).toBeNull();
  });

  it('no quiet question while a permission card waits for the person', async () => {
    const { c } = cockpit([]);
    const { api } = fakeApi(state({ phase: 'needs_input', quietSecs: 300 }));
    await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
    await flush();
    expect(host.querySelector('[data-testid="acp-quiet"]')).toBeNull();
  });

  it('a chat that was closed on purpose shows no stopped line', async () => {
    const { c } = cockpit([]);
    const { api } = fakeApi(state({ phase: 'exited', turnInFlight: false, exit: { kind: 'closed', code: null, reason: null } }));
    await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
    await flush();
    expect(host.querySelector('[data-testid="acp-dock"]')).toBeNull();
  });

  it('shows nothing while the session is idle and nothing is asked', async () => {
    const { c } = cockpit([]);
    const { api } = fakeApi(state({ turnInFlight: false, phase: 'idle', status: 'idle' }));
    await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
    await flush();
    expect(host.querySelector('[data-testid="acp-dock"]')).toBeNull();
  });

  it("shows the agent's question with the agent's own options and sends the chosen one", async () => {
    const { c, answerQuestion } = cockpit([question(), question({ id: 'other', pane_id: 'p2' })]);
    const { api } = fakeApi(state({ phase: 'needs_input', status: 'waiting_input' }));
    await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
    await flush();
    expect(host.textContent).toContain('Write notes.txt');
    expect(host.textContent).toContain('Codex');
    expect(host.querySelectorAll('[aria-label="Agent permission question"]').length).toBe(1);
    expect(['Allow Once', 'Allow for Session', 'Reject'].map((t) => !!button(t))).toEqual([true, true, true]);
    // The strip tells that the agent waits for the answer.
    expect(host.querySelector('[data-testid="acp-strip"]')).toBeNull();
    await act(async () => button('Allow for Session')!.click());
    expect(answerQuestion).toHaveBeenCalledWith('q1', { choice_id: 'allow_always' });
  });

  it('dismissing the card is a no, and goes through the same route as every card', async () => {
    const { c, dismissQuestion } = cockpit([question()]);
    const { api } = fakeApi(state({ phase: 'needs_input' }));
    await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
    await flush();
    const dismiss = buttons().find((b) => b.textContent === 'Dismiss');
    expect(dismiss).toBeTruthy();
    await act(async () => dismiss!.click());
    expect(dismissQuestion).toHaveBeenCalledWith('q1');
  });

  it('a plain running turn draws no strip: Working… and Stop live in the message box', async () => {
    const { c } = cockpit([]);
    const { api, emit } = fakeApi(state());
    await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
    await flush();
    expect(host.querySelector('[data-testid="acp-strip"]')).toBeNull();
    expect(host.querySelector('[data-testid="acp-dock"]')).toBeNull();
    await emit(state({ phase: 'cancelling', stopping: true }));
    expect(host.querySelector('[data-testid="acp-strip"]')).toBeNull();
  });

  describe('"Let agents answer these questions"', () => {
    const sw = () => host.querySelector<HTMLButtonElement>('[data-testid="agent-answering"] [role="switch"]');
    const note = () => host.querySelector('[data-testid="agent-answering"] .ck-acp-answering-note')?.textContent;

    it('is shown with an open question, off, with the plain note', async () => {
      const { c } = cockpit([question()]);
      const { api } = fakeApi(state({ phase: 'needs_input', agentAnswering: false }));
      await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
      await flush();
      expect(host.querySelector('[data-testid="agent-answering"]')?.textContent).toContain('Let agents answer these questions');
      expect(sw()!.getAttribute('aria-checked')).toBe('false');
      expect(note()).toBe('Off: only you can answer.');
    });

    it('is not shown when no question is open', async () => {
      const { c } = cockpit([]);
      const { api } = fakeApi(state());
      await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
      await flush();
      expect(host.querySelector('[data-testid="agent-answering"]')).toBeNull();
    });

    it('turning it on asks the backend, shows it on at once, and keeps what the backend then says', async () => {
      const { c } = cockpit([question()]);
      const setAgentAnswering = vi.fn(async (_id: string, allowed: boolean) => state({ agentAnswering: allowed }));
      const { api, emit } = fakeApi(state({ phase: 'needs_input' }), { setAgentAnswering });
      await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
      await flush();
      await act(async () => sw()!.click());
      expect(setAgentAnswering).toHaveBeenCalledWith('p1', true);
      expect(sw()!.getAttribute('aria-checked')).toBe('true');
      expect(note()).toBe('On: an agent that started this chat may answer its permission questions.');
      await emit(state({ phase: 'needs_input', agentAnswering: true }));
      expect(sw()!.getAttribute('aria-checked')).toBe('true');
      // And off again.
      await act(async () => sw()!.click());
      expect(setAgentAnswering).toHaveBeenLastCalledWith('p1', false);
    });

    it('goes back to off, with the sentence, when the backend refuses', async () => {
      const { c } = cockpit([question()]);
      const setAgentAnswering = vi.fn(async (): Promise<AcpChatState> => {
        throw 'ACP_CLOSED: This chat is closed.';
      });
      const { api } = fakeApi(state({ phase: 'needs_input' }), { setAgentAnswering });
      await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
      await flush();
      await act(async () => sw()!.click());
      await flush();
      expect(sw()!.getAttribute('aria-checked')).toBe('false');
      expect(host.querySelector('[data-testid="agent-answering"] [role="alert"]')?.textContent).toBe('This chat is closed.');
    });
  });

  describe('decision card', () => {
    const permission = (over: Record<string, unknown> = {}) => ({
      askId: 1,
      title: 'rm -rf dist',
      toolKind: 'execute',
      questionId: 'q1',
      options: [
        { id: 'allow_once', name: 'Allow Once', kind: 'allow_once' },
        { id: 'allow_always', name: 'Allow for Session', kind: 'allow_always' },
        { id: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
      sinceMs: 0,
      ...over,
    });

    it('shows the kind, the command, the first yes filled, and sends the choice', async () => {
      const { c, answerQuestion } = cockpit([question()]);
      const { api } = fakeApi(state({ phase: 'needs_input', permissions: [permission()] }));
      await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
      await flush();
      expect(host.querySelector('[data-testid="decision-kind"]')?.textContent).toBe('Run command');
      expect(host.querySelector('[data-testid="decision-what"]')?.textContent).toBe('rm -rf dist');
      expect(button('Allow Once')!.className).toContain('ck-dc-btn--pri');
      expect(button('Allow for Session')!.className).not.toContain('ck-dc-btn--pri');
      expect(button('Reject')!.className).toContain('ck-dc-btn--no');
      await act(async () => button('Allow Once')!.click());
      expect(answerQuestion).toHaveBeenCalledWith('q1', { choice_id: 'allow_once' });
    });

    it("'Don't ask again' tells the chat to remember the kind first, then answers", async () => {
      const { c, answerQuestion } = cockpit([question()]);
      const order: string[] = [];
      const setAutoAllow = vi.fn(async () => {
        order.push('remember');
        return state();
      });
      answerQuestion.mockImplementation(async () => {
        order.push('answer');
      });
      const { api } = fakeApi(state({ phase: 'needs_input', permissions: [permission()] }), { setAutoAllow });
      await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
      await flush();
      const box = host.querySelector<HTMLInputElement>('[data-testid="decision-never"] input')!;
      await act(async () => box.click());
      await act(async () => button('Allow Once')!.click());
      await flush();
      expect(setAutoAllow).toHaveBeenCalledWith('p1', 'execute', true);
      expect(order).toEqual(['remember', 'answer']);
    });

    it('a no never remembers, even with the switch on', async () => {
      const { c, answerQuestion } = cockpit([question()]);
      const setAutoAllow = vi.fn(async () => state());
      const { api } = fakeApi(state({ phase: 'needs_input', permissions: [permission()] }), { setAutoAllow });
      await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
      await flush();
      await act(async () => host.querySelector<HTMLInputElement>('[data-testid="decision-never"] input')!.click());
      await act(async () => button('Reject')!.click());
      expect(setAutoAllow).not.toHaveBeenCalled();
      expect(answerQuestion).toHaveBeenCalledWith('q1', { choice_id: 'reject_once' });
    });

    it('delete hides the switch and needs a held press for the yes', async () => {
      const { c, answerQuestion } = cockpit([question()]);
      const { api } = fakeApi(state({ phase: 'needs_input', permissions: [permission({ toolKind: 'delete', title: 'Delete 3 files' })] }), { setAutoAllow: vi.fn(async () => state()) });
      await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
      await flush();
      expect(host.querySelector('[data-testid="decision-never"]')).toBeNull();
      expect(host.textContent).toContain('Risky');
      const hold = buttons().find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Hold to choose: Allow Once'))!;
      // A plain click does nothing.
      await act(async () => hold.click());
      expect(answerQuestion).not.toHaveBeenCalled();
      const key = (type: 'keydown' | 'keyup') => act(async () => void hold.dispatchEvent(new KeyboardEvent(type, { key: ' ', bubbles: true, cancelable: true })));
      const wait = (ms: number) => act(async () => new Promise<void>((r) => setTimeout(r, ms)));
      // Released too early: nothing.
      await key('keydown');
      await wait(200);
      await key('keyup');
      await wait(900);
      expect(answerQuestion).not.toHaveBeenCalled();
      // Held long enough: the yes goes.
      await key('keydown');
      await wait(1000);
      expect(answerQuestion).toHaveBeenCalledWith('q1', { choice_id: 'allow_once' });
    });

    it('an unknown kind hides the switch', async () => {
      const { c } = cockpit([question()]);
      const { api } = fakeApi(state({ phase: 'needs_input', permissions: [permission({ toolKind: null })] }), { setAutoAllow: vi.fn(async () => state()) });
      await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
      await flush();
      expect(host.querySelector('[data-testid="decision-never"]')).toBeNull();
    });

    it('a long command folds to two lines and Show full opens it', async () => {
      const { c } = cockpit([question()]);
      const long = 'Select-String -Path "C:\\Program Files\\App\\resources\\brain.mjs" -Pattern "workspace" -SimpleMatch -CaseSensitive';
      const { api } = fakeApi(state({ phase: 'needs_input', permissions: [permission({ title: long })] }));
      await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
      await flush();
      const what = host.querySelector('[data-testid="decision-what"]')!;
      expect(what.hasAttribute('data-open')).toBe(false);
      await act(async () => buttons().find((b) => b.textContent === 'Show full')!.click());
      expect(what.hasAttribute('data-open')).toBe(true);
      expect(buttons().some((b) => b.textContent === 'Show less')).toBe(true);
    });

    it('lists what is not asked about in this chat, with a way back', async () => {
      const { c } = cockpit([]);
      const setAutoAllow = vi.fn(async () => state());
      const { api } = fakeApi(state({ autoAllow: ['execute'] }), { setAutoAllow });
      await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
      await flush();
      const line = host.querySelector('[data-testid="auto-allow-line"]')!;
      expect(line.textContent).toContain('Not asking for: Run command');
      await act(async () => buttons().find((b) => b.textContent === 'Turn back on')!.click());
      expect(setAutoAllow).toHaveBeenCalledWith('p1', 'execute', false);
    });

    it('more questions waiting are counted, not stacked', async () => {
      const { c } = cockpit([question(), question({ id: 'q2' })]);
      const { api } = fakeApi(state({ phase: 'needs_input', permissions: [permission()] }));
      await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Codex" api={api} />));
      await flush();
      expect(host.querySelectorAll('[data-testid="decision-card"]').length).toBe(1);
      expect(host.textContent).toContain('1 more waiting');
    });
  });

  it('a chat that needs a sign-in shows the card; Open sign-in opens the agent terminal in the pane folder, then try again', async () => {
    const newAgent = vi.fn(async () => 'term-1');
    const c = { now: 5, asked: { questions: [], answerQuestion: vi.fn(), dismissQuestion: vi.fn() }, newAgent, registry: { panes: new Map([['p1', { info: { cwd: '/work/app' } }]]) } } as unknown as CockpitApi;
    const retrySignIn = vi.fn(async () => undefined);
    const { api, emit } = fakeApi(state({ turnInFlight: false, phase: 'idle', status: 'idle', agent: 'claude', label: 'Claude' }));
    api.retrySignIn = retrySignIn;
    await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Claude" api={api} />));
    await flush();
    expect(host.querySelector('[data-testid="signin-card"]')).toBeNull();

    await emit(state({ turnInFlight: false, phase: 'idle', status: 'idle', agent: 'claude', label: 'Claude', signIn: { needed: true, hint: 'Type /login in the terminal.' } }));
    const card = host.querySelector('[data-testid="signin-card"]')!;
    expect(card.textContent).toContain('Sign in to Claude to use Chat');
    expect(card.textContent).toContain('Type /login in the terminal.');

    await act(async () => button('Open sign-in')!.click());
    expect(newAgent).toHaveBeenCalledWith('claude', undefined, false, '/work/app');
    await act(async () => buttons().find((b) => /signed in — try again/.test(b.textContent ?? ''))!.click());
    expect(retrySignIn).toHaveBeenCalledWith('p1');

    // The backend clears the flag once the message went: the card goes.
    await emit(state({ turnInFlight: true, agent: 'claude', label: 'Claude', signIn: { needed: false, hint: '' } }));
    expect(host.querySelector('[data-testid="signin-card"]')).toBeNull();
  });
});
