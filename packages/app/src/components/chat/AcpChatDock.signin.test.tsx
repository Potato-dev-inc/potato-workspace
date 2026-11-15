// @vitest-environment jsdom
// "Sign in without a terminal": when a chat needs its agent's sign-in, the card is two steps ("1. Your browser opens. 2. Come
// back here."), the agent's own sign-in runs in a hidden pane, its terminal is folded under Details and opens by itself when
// the sign-in asks a question, and the kept message is sent again once it worked. No terminal pane is opened.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { AcpChatApi, AcpChatState } from '../../lib/acpChat';
import { fakeAcpApi } from '../../lib/acpChatFake';
import type { ChatSignIn, SignInStatus } from '../../lib/chatMore';
import { USAGE_REFRESH_EVENT } from '../../lib/usage';
import { AcpChatDock } from './AcpChatDock';

vi.mock('../lend/SignInTerminal', async () => {
  const { createElement } = await import('react');
  return { SignInTerminal: ({ paneId }: { paneId: string }) => createElement('div', { 'data-testid': 'term-stub' }, paneId) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = (over: Partial<AcpChatState> = {}): AcpChatState => ({
  lane: 'acp',
  agent: 'claude',
  label: 'Claude',
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
  signIn: { needed: true, hint: 'Type /login in the terminal.', text: 'add the date format to the report' },
  ...over,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const card = () => host.querySelector('[data-testid="signin-fix-card"]');
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text);
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function setup(retry: () => Promise<void>) {
  const newAgent = vi.fn(async () => 'term-1');
  const c = {
    now: 5,
    asked: { questions: [], answerQuestion: vi.fn(), dismissQuestion: vi.fn() },
    newAgent,
    launchEntries: [{ type: 'claude', label: 'Claude' }],
    registry: { panes: new Map([['p1', { info: { cwd: '/work/app' } }]]) },
  } as unknown as CockpitApi;
  let status: SignInStatus = { alive: true, asking: false, pane_id: 'hidden-1' };
  const driver: ChatSignIn = {
    start: vi.fn(async () => 'hidden-1'),
    status: vi.fn(async () => status),
    stop: vi.fn(async () => undefined),
  };
  let push: ((paneId: string, next: AcpChatState) => void) | null = null;
  const api: AcpChatApi = fakeAcpApi({
    state: async () => state(),
    watch: async (cb) => {
      push = cb;
      return () => {
        push = null;
      };
    },
    retrySignIn: retry,
    signIn: () => driver,
  });
  return { c, api, driver, newAgent, setStatus: (next: SignInStatus) => (status = next), emit: (next: AcpChatState) => act(async () => push?.('p1', next)) };
}

async function mount(s: ReturnType<typeof setup>) {
  await act(async () => root.render(<AcpChatDock c={s.c} paneId="p1" paneName="Claude" api={s.api} />));
  await tick(0);
}

describe('the sign-in card without a terminal', () => {
  it('shows two steps and one Sign in button, and no terminal', async () => {
    const s = setup(vi.fn(async () => undefined));
    await mount(s);
    await s.emit(state());
    const text = card()!.textContent ?? '';
    expect(text).toContain('Your browser opens.');
    expect(text).toContain('Come back here.');
    expect(button('Sign in')).toBeTruthy();
    expect(host.querySelector('[data-testid="signin-details"]')).toBeNull();
    expect(host.querySelector('[data-testid="term-stub"]')).toBeNull();
  });

  it('Sign in starts the hidden sign-in (no terminal pane), keeps Details folded, and opens it by itself when a question comes', async () => {
    const retry = vi.fn(async () => {
      throw new Error('ACP_SIGN_IN_NEEDED: still out');
    });
    const s = setup(retry);
    await mount(s);
    await s.emit(state());
    await act(async () => button('Sign in')!.click());
    expect(s.driver.start).toHaveBeenCalledTimes(1);
    expect(s.newAgent).not.toHaveBeenCalled();
    const details = host.querySelector<HTMLDetailsElement>('[data-testid="signin-details"]')!;
    expect(details.open).toBe(false);
    expect(host.querySelector('[data-testid="term-stub"]')).toBeNull();
    expect(host.querySelector('[data-testid="signin-working"]')!.textContent).toContain('Waiting for you to finish');

    // Nothing asked yet: still folded.
    await tick(1600);
    expect(details.open).toBe(false);

    // The sign-in asks a question: Details opens and the terminal of the hidden pane is shown.
    s.setStatus({ alive: true, asking: true, pane_id: 'hidden-1' });
    await tick(1600);
    expect(details.open).toBe(true);
    expect(host.querySelector('[data-testid="term-stub"]')!.textContent).toBe('hidden-1');
    expect(host.querySelector('[data-testid="signin-working"]')!.textContent).toContain('question for you');
  });

  it('once the kept message goes through, the card says so and the hidden sign-in is stopped', async () => {
    let signedIn = false;
    const retry = vi.fn(async () => {
      if (!signedIn) throw new Error('ACP_SIGN_IN_NEEDED: still out');
    });
    let refreshes = 0;
    const count = () => void refreshes++;
    window.addEventListener(USAGE_REFRESH_EVENT, count);
    const s = setup(retry);
    await mount(s);
    await s.emit(state());
    await act(async () => button('Sign in')!.click());
    await tick(6100);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(s.driver.stop).not.toHaveBeenCalled();
    signedIn = true;
    await tick(6100);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(card()!.textContent).toContain('Sent again');
    expect(s.driver.stop).toHaveBeenCalled();
    expect(host.querySelector('[data-testid="signin-details"]')).toBeNull();
    // The usage row of this agent is read again (its "Sign-in expired" clears), once.
    expect(refreshes).toBe(1);
    window.removeEventListener(USAGE_REFRESH_EVENT, count);
    // Sent once only.
    await tick(60_000);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it('a sign-in that closed before it was done says so and offers Sign in again', async () => {
    const s = setup(vi.fn(async () => { throw new Error('ACP_SIGN_IN_NEEDED: still out'); }));
    await mount(s);
    await s.emit(state());
    await act(async () => button('Sign in')!.click());
    s.setStatus({ alive: false, asking: false, pane_id: null });
    await tick(1600);
    expect(host.querySelector('[data-testid="signin-working"]')!.textContent).toContain('closed before it was done');
    expect(button('Sign in')).toBeTruthy();
    await act(async () => button('Sign in')!.click());
    expect(s.driver.start).toHaveBeenCalledTimes(2);
  });

  it('closing the chat card stops the hidden sign-in', async () => {
    const s = setup(vi.fn(async () => { throw new Error('ACP_SIGN_IN_NEEDED: still out'); }));
    await mount(s);
    await s.emit(state());
    await act(async () => button('Sign in')!.click());
    // The backend clears the flag (for example the chat was restarted): the card goes, and so does the hidden pane.
    await s.emit(state({ signIn: { needed: false, hint: '' } }));
    expect(card()).toBeNull();
    expect(s.driver.stop).toHaveBeenCalled();
  });
});
