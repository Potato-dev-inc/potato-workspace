// @vitest-environment jsdom
// Phone chat parity (phone-acp): start a chat from the phone, ACP streaming with its permission card, the settings picker, closed
// chats in the drawer, and the long-press message actions. All through the whole phone app with a faked bridge.
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pane = (id: string, lane?: 'acp') => ({
  id,
  agent_type: 'codex',
  status: 'idle',
  created_at: 1,
  cwd: 'C:/x',
  pid: lane ? 0 : 1,
  last_output_at: null,
  cols: 80,
  rows: 24,
  ...(lane ? { lane } : {}),
});

const state = (over: Record<string, unknown> = {}) => ({
  lane: 'acp',
  agent: 'codex',
  label: 'Codex',
  phase: 'idle',
  status: 'idle',
  turnInFlight: false,
  stopping: false,
  canSteer: false,
  turn: 1,
  title: null,
  usage: null,
  permissions: [],
  closed: false,
  ...over,
});

const question = {
  id: 'q1',
  question: 'Codex asks permission: Write notes.txt',
  choices: [
    { id: 'allow_once', label: 'Allow Once' },
    { id: 'allow_always', label: 'Allow for Session' },
    { id: 'reject_once', label: 'Reject' },
  ],
  allow_free_text: false,
  urgency: 'high',
  created_at_ms: Date.now(),
  expires_at_ms: Date.now() + 3_600_000,
  state: 'pending',
  kind: 'acp_permission',
  pane_id: 'c1',
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem('pm.bridge.url', 'http://phone.test');
  h.claim.mockClear();
  h.terminalMounts = 0;
  h.caps = ['watch', 'answer', 'type', 'control'];
  h.panes = [pane('c1', 'acp'), pane('t1')];
  h.questions = [];
  h.paneChat.mockReset();
  h.paneChat.mockResolvedValue({ available: true, reason: null, source: 'acp', waitingFor: null, rev: 1, reset: false, items: [] });
  h.acpSession.mockReset();
  h.acpSession.mockResolvedValue(state());
  h.acpCancel.mockReset();
  h.acpCancel.mockResolvedValue({ stopped: true });
  h.phoneNewChat.mockReset();
  h.phoneNewChat.mockResolvedValue({
    agents: [
      { id: 'codex', label: 'Codex', chat: true, terminal: true },
      { id: 'kilo', label: 'Kilo', chat: true, terminal: false },
    ],
    projects: [
      { id: 'p1', name: 'shop', state: 'repo' },
      { id: 'p2', name: 'blog', state: 'folder' },
    ],
  });
  h.phoneStartChat.mockReset();
  h.phoneStartChat.mockResolvedValue({ pane_id: 'c1', agent: 'codex', lane: 'chat' });
  h.sendPaneMessage.mockReset();
  h.sendPaneMessage.mockResolvedValue({ id: 'm1', text: 'x', state: 'queued', created_at: 1 });
  h.acpSetConfig.mockReset();
  h.acpSetConfig.mockResolvedValue(state());
  h.acpClosed.mockReset();
  h.acpClosed.mockResolvedValue([]);
  h.acpReopen.mockReset();
  h.acpReopen.mockResolvedValue({ pane_id: 'old1' });
  h.answerQuestion.mockReset();
  h.answerQuestion.mockResolvedValue({ accepted: true });
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

const buttonNamed = (name: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === name);
const flush = (ms = 50) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });


const byLabel = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const radioNamed = (name: string) => Array.from(host.querySelectorAll('[role="radio"]')).find((b) => b.textContent?.includes(name)) as HTMLButtonElement | undefined;
const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click(); await vi.advanceTimersByTimeAsync(20); });
const setValue = (el: HTMLTextAreaElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
const press = (el: Element, type: 'pointerdown' | 'pointerup') => el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 10, clientY: 10 }));

const configState = (over: Record<string, unknown> = {}) =>
  state({
    configOptions: [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'big', options: [{ value: 'big', name: 'Big model', description: 'Slow and careful' }, { value: 'fast', name: 'Fast model' }] },
      { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Ask each time' }, { value: 'bypassPermissions', name: 'Full access' }] },
      { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'med', options: [{ value: 'low', name: 'Low' }, { value: 'med', name: 'Medium' }, { value: 'high', name: 'High' }] },
    ],
    ...over,
  });

describe('start a chat from the phone', () => {
  it('the new-chat button opens an empty chat with the agent, the project and the Chat / Terminal pills; Send starts it with the first message', async () => {
    await open('c1');
    await flush();
    await click(byLabel('New chat'));
    await flush();
    const screen = host.querySelector('[data-testid="phone-new-chat"]')!;
    expect(screen).not.toBeNull();
    expect(screen.querySelector('[data-testid="nc-agent-pill"]')?.textContent).toContain('Agent: Codex');
    expect(screen.querySelector('[data-testid="nc-project-pill"]')?.textContent).toContain('Project: shop');
    // Codex can do both, so the choice shows; Chat is the default.
    expect(radioNamed('Chat')?.getAttribute('aria-checked')).toBe('true');
    await click(radioNamed('Terminal'));
    await setValue(screen.querySelector('textarea') as HTMLTextAreaElement, 'fix the login page');
    await click(screen.querySelector('button[type="submit"]'));
    await flush();
    expect(h.phoneStartChat).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex', project: 'p1', lane: 'terminal' }));
    expect(h.sendPaneMessage).toHaveBeenCalledWith('c1', 'fix the login page');
    expect(host.querySelector('[data-testid="phone-new-chat"]')).toBeNull();
  });

  it('an agent that only chats has no Chat / Terminal choice, and the project pill lists only projects the PC knows', async () => {
    await open('c1');
    await flush();
    await click(byLabel('New chat'));
    await flush();
    await click(host.querySelector('[data-testid="nc-agent-pill"]'));
    await click(Array.from(host.querySelectorAll('.ph-nc-list button')).find((b) => b.textContent?.includes('Kilo')));
    expect(host.querySelector('[data-testid="nc-lane"]')).toBeNull();
    await click(host.querySelector('[data-testid="nc-project-pill"]'));
    const names = Array.from(host.querySelectorAll('.ph-nc-list .ph-t')).map((n) => n.textContent);
    expect(names).toEqual(['shop', 'blog']);
    await click(Array.from(host.querySelectorAll('.ph-nc-list button')).find((b) => b.textContent?.includes('blog')));
    await setValue(host.querySelector('.ph-nc textarea') as HTMLTextAreaElement, 'hello');
    await click(host.querySelector('.ph-nc button[type="submit"]'));
    await flush();
    expect(h.phoneStartChat).toHaveBeenCalledWith(expect.objectContaining({ agent: 'kilo', project: 'p2', lane: 'chat' }));
  });

  it('a phone without the control right gets one plain line and cannot send', async () => {
    h.caps = ['watch', 'type'];
    await open('c1');
    await flush();
    await click(byLabel('New chat'));
    await flush();
    const screen = host.querySelector('[data-testid="phone-new-chat"]')!;
    expect(screen.textContent).toContain('This phone may not start chats.');
    expect((screen.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true);
    expect(h.phoneStartChat).not.toHaveBeenCalled();
  });

  it("a refused start shows the PC's sentence and keeps the screen open", async () => {
    h.phoneStartChat.mockRejectedValue(new Error('bridge POST /phone/chats -> 404: The PC does not know that project. Open it on the PC first.'));
    await open('c1');
    await flush();
    await click(byLabel('New chat'));
    await flush();
    await setValue(host.querySelector('.ph-nc textarea') as HTMLTextAreaElement, 'hi');
    await click(host.querySelector('.ph-nc button[type="submit"]'));
    await flush();
    expect(host.querySelector('[data-testid="phone-new-chat"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="phone-composer-note"]')?.textContent).toContain('The PC does not know that project');
    expect(h.sendPaneMessage).not.toHaveBeenCalled();
  });
});

describe('a chat over ACP on the phone', () => {
  it("shows thoughts collapsed, tool steps folded and the plan, and the permission card with the agent's own options", async () => {
    h.paneChat.mockResolvedValue({
      available: true,
      reason: null,
      source: 'acp',
      waitingFor: null,
      rev: 2,
      reset: true,
      items: [
        { kind: 'user', id: 'u1', at: null, text: 'add a note file' },
        { kind: 'thinking', id: 't1', at: null, text: 'I should write the file first', durationMs: 1200 },
        { kind: 'toolCall', id: 'c1', at: null, callId: 'k1', name: 'Read', summary: 'Read notes.txt', paths: ['notes.txt'] },
        { kind: 'toolResult', id: 'r1', at: null, callId: 'k1', ok: true, output: 'ok' },
        { kind: 'plan', id: 'p1', at: null, replace: true, items: [{ text: 'Write the file', status: 'in_progress' }] },
        { kind: 'assistant', id: 'a1', at: null, text: 'Writing it now.', model: null, finalAnswer: false },
      ],
    });
    h.questions = [{ ...question }];
    h.acpSession.mockResolvedValue(state({ phase: 'needs_input', status: 'waiting_input', turnInFlight: true }));
    await open('c1');
    await flush();
    expect(host.querySelector('[data-testid="thinking-block"] [aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('[data-testid="phone-fold"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="chat-plan"]')?.textContent).toContain('Write the file');
    expect(host.textContent).toContain('Writing it now.');
    for (const name of ['Allow Once', 'Allow for Session', 'Reject']) expect(buttonNamed(name)).toBeTruthy();
    await click(buttonNamed('Allow Once'));
    expect(h.answerQuestion).toHaveBeenCalledWith('q1', { choice_id: 'allow_once' });
  });

  it('a message sent while the agent works goes through the message route, and Stop cancels the turn', async () => {
    h.acpSession.mockResolvedValue(state({ phase: 'working', status: 'running', turnInFlight: true }));
    await open('c1');
    await flush();
    await setValue(host.querySelector('[data-testid="phone-composer"] textarea') as HTMLTextAreaElement, 'and add tests');
    await click(host.querySelector('[data-testid="phone-composer"] button[type="submit"]'));
    expect(h.sendPaneMessage).toHaveBeenCalledWith('c1', 'and add tests');
    await click(buttonNamed('Stop'));
    expect(h.acpCancel).toHaveBeenCalledWith('c1');
  });
});

describe('the settings picker', () => {
  it('the pill shows the model, opens every setting the agent sends with its descriptions, and a pick calls the PC', async () => {
    h.acpSession.mockResolvedValue(configState());
    await open('c1');
    await flush();
    const pill = host.querySelector('[data-testid="phone-pick-pill"]')!;
    expect(pill.textContent).toContain('Big model');
    await click(pill);
    const sheet = host.querySelector('[data-testid="phone-pick-sheet"]')!;
    expect(Array.from(sheet.querySelectorAll('h3')).map((n) => n.textContent)).toEqual(['Permissions', 'Model', 'Effort']);
    expect(sheet.textContent).toContain('Slow and careful');
    await click(radioNamed('Fast model'));
    expect(h.acpSetConfig).toHaveBeenCalledWith('c1', 'model', 'fast', false);
    await click(radioNamed('High'));
    expect(h.acpSetConfig).toHaveBeenCalledWith('c1', 'effort', 'high', false);
  });

  it('full access wears the yellow shield and needs a press and hold', async () => {
    h.acpSession.mockResolvedValue(configState());
    await open('c1');
    await flush();
    await click(host.querySelector('[data-testid="phone-pick-pill"]'));
    expect(host.querySelector('.ph-pick-opt[data-risk] .ph-pick-shield')).not.toBeNull();
    await click(radioNamed('Full access'));
    expect(h.acpSetConfig).not.toHaveBeenCalled();
    const hold = host.querySelector('.ph-pick-hold') as HTMLButtonElement;
    expect(hold.textContent).toContain('Hold to allow full access');
    // A tap that lets go early does nothing.
    await act(async () => { press(hold, 'pointerdown'); await vi.advanceTimersByTimeAsync(300); press(hold, 'pointerup'); await vi.advanceTimersByTimeAsync(1200); });
    expect(h.acpSetConfig).not.toHaveBeenCalled();
    await act(async () => { press(hold, 'pointerdown'); await vi.advanceTimersByTimeAsync(1100); });
    expect(h.acpSetConfig).toHaveBeenCalledWith('c1', 'mode', 'bypassPermissions', true);
  });

  it('the waiting hold button stays while the PC keeps sending fresh copies of the same settings', async () => {
    h.acpSession.mockImplementation(async () => JSON.parse(JSON.stringify(configState())));
    await open('c1');
    await flush();
    await click(host.querySelector('[data-testid="phone-pick-pill"]'));
    await click(radioNamed('Full access'));
    expect(host.querySelector('.ph-pick-hold')).not.toBeNull();
    await flush(5000);
    expect(host.querySelector('.ph-pick-hold')).not.toBeNull();
  });

  it('is switched off while the agent works', async () => {
    h.acpSession.mockResolvedValue(configState({ phase: 'working', status: 'running', turnInFlight: true }));
    await open('c1');
    await flush();
    await click(host.querySelector('[data-testid="phone-pick-pill"]'));
    expect(host.querySelector('[data-testid="phone-pick-sheet"]')?.textContent).toContain('The agent is working.');
    expect(radioNamed('Fast model')!.disabled).toBe(true);
    await click(radioNamed('Fast model'));
    expect(h.acpSetConfig).not.toHaveBeenCalled();
  });

  it('a phone without the control right sees the settings but cannot change them', async () => {
    h.caps = ['watch', 'answer', 'type'];
    h.acpSession.mockResolvedValue(configState());
    await open('c1');
    await flush();
    await click(host.querySelector('[data-testid="phone-pick-pill"]'));
    expect(host.querySelector('[data-testid="phone-pick-sheet"]')?.textContent).toContain('This phone may not change settings.');
    expect(radioNamed('Fast model')!.disabled).toBe(true);
  });

  it('a refused pick is taken back and says so', async () => {
    h.acpSession.mockResolvedValue(configState());
    h.acpSetConfig.mockRejectedValue(new Error('bridge POST /acp/sessions/c1/config -> 403: no'));
    await open('c1');
    await flush();
    await click(host.querySelector('[data-testid="phone-pick-pill"]'));
    await click(radioNamed('Fast model'));
    await flush();
    expect(host.querySelector('[data-testid="phone-pick-sheet"]')?.textContent).toContain('does not let this phone change that');
    expect(radioNamed('Big model')?.getAttribute('aria-checked')).toBe('true');
  });
});

describe('closed chats in the drawer', () => {
  const closed = { id: 'old1', agent: 'codex', label: 'Codex', folder: 'shop', updated_ms: Date.now() - 3_600_000, title: 'fix the login page' };

  it('lists the closed chats under a Closed part and reopens one', async () => {
    h.acpClosed.mockResolvedValue([closed]);
    h.acpReopen.mockImplementation(async () => {
      h.panes = [...h.panes, pane('old1', 'acp')];
      return { pane_id: 'old1' };
    });
    await open('c1');
    await flush();
    await click(host.querySelector('button[aria-label^="Open chats"]'));
    await flush();
    const section = host.querySelector('[data-testid="drawer-closed"]')!;
    expect(section.querySelector('h2')?.textContent).toBe('Closed');
    expect(section.querySelectorAll('.ph-drow').length).toBe(0);
    await click(section.querySelector('.ph-dclosed-toggle'));
    expect(section.textContent).toContain('fix the login page');
    expect(section.textContent).toContain('shop');
    await click(section.querySelector('.ph-drow'));
    await flush();
    expect(h.acpReopen).toHaveBeenCalledWith('old1');
    expect(host.querySelector('[data-testid="phone-drawer"]')).toBeNull();
    expect(h.paneChat).toHaveBeenCalledWith('old1', undefined);
  });

  it('shows no Closed part when nothing is closed, and switches the rows off without the control right', async () => {
    await open('c1');
    await flush();
    await click(host.querySelector('button[aria-label^="Open chats"]'));
    await flush();
    expect(host.querySelector('[data-testid="drawer-closed"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    h.caps = ['watch', 'answer', 'type'];
    h.acpClosed.mockResolvedValue([closed]);
    await open('c1');
    await flush();
    await click(host.querySelector('button[aria-label^="Open chats"]'));
    await flush();
    await click(host.querySelector('.ph-dclosed-toggle'));
    expect((host.querySelector('[data-testid="drawer-closed"] .ph-drow') as HTMLButtonElement).disabled).toBe(true);
    expect(host.querySelector('[data-testid="drawer-closed"]')?.textContent).toContain('This phone may not reopen chats.');
  });
});

describe('long press on a message', () => {
  const items = [
    { kind: 'user', id: 'u1', at: null, text: 'please fix the login' },
    { kind: 'assistant', id: 'a1', at: null, text: 'Done: the login works.', model: null, finalAnswer: true },
    { kind: 'turnEnd', id: 'e1', at: null, outcome: 'completed', durationMs: 10 },
  ];
  beforeEach(() => {
    h.paneChat.mockResolvedValue({ available: true, reason: null, source: 'acp', waitingFor: null, rev: 2, reset: true, items });
  });

  it('on your message: Copy, Select text, Edit and send again, Retry; Retry sends a new message', async () => {
    await open('c1');
    await flush();
    const bubble = host.querySelector('.ph-you-bubble')!;
    await act(async () => { press(bubble, 'pointerdown'); await vi.advanceTimersByTimeAsync(600); });
    const menu = host.querySelector('[data-testid="phone-msg-actions"]')!;
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent)).toEqual(['Copy', 'Select text', 'Edit and send again', 'Retry']);
    await click(buttonNamed('Retry'));
    expect(h.sendPaneMessage).toHaveBeenCalledWith('c1', 'please fix the login');
    expect(host.querySelector('[data-testid="phone-msg-actions"]')).toBeNull();
  });

  it('Edit and send again puts the words in the box and sends nothing', async () => {
    await open('c1');
    await flush();
    await act(async () => { press(host.querySelector('.ph-you-bubble')!, 'pointerdown'); await vi.advanceTimersByTimeAsync(600); });
    await click(buttonNamed('Edit and send again'));
    expect((host.querySelector('[data-testid="phone-composer"] textarea') as HTMLTextAreaElement).value).toBe('please fix the login');
    expect(h.sendPaneMessage).not.toHaveBeenCalled();
  });

  it("on the agent's words there is no Edit or Retry, and Select text shows the words to pick", async () => {
    await open('c1');
    await flush();
    await act(async () => { press(host.querySelector('.ph-agent-text')!, 'pointerdown'); await vi.advanceTimersByTimeAsync(600); });
    const menu = host.querySelector('[data-testid="phone-msg-actions"]')!;
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent)).toEqual(['Copy', 'Select text']);
    await click(buttonNamed('Select text'));
    expect((host.querySelector('[data-testid="phone-msg-select"] textarea') as HTMLTextAreaElement).value).toBe('Done: the login works.');
  });

  it('a short press does nothing', async () => {
    await open('c1');
    await flush();
    await act(async () => { press(host.querySelector('.ph-you-bubble')!, 'pointerdown'); await vi.advanceTimersByTimeAsync(200); press(host.querySelector('.ph-you-bubble')!, 'pointerup'); await vi.advanceTimersByTimeAsync(600); });
    expect(host.querySelector('[data-testid="phone-msg-actions"]')).toBeNull();
  });

  it('Share shows only where the phone can share', async () => {
    vi.stubGlobal('navigator', { ...navigator, share: vi.fn(async () => undefined) });
    await open('c1');
    await flush();
    await act(async () => { press(host.querySelector('.ph-agent-text')!, 'pointerdown'); await vi.advanceTimersByTimeAsync(600); });
    expect(buttonNamed('Share')).toBeTruthy();
  });
});

