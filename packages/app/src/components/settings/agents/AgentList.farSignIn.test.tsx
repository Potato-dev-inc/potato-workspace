// @vitest-environment jsdom
// P2.2: a signed-out agent on ANOTHER PC shows the same card and words as on this PC, and Sign in runs on that PC.
// The far host is a fake whose `invoke` stands for `POST /pclink/call/<command>`; nothing of this PC (usage, accounts) is mixed in.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signInFor } from '../../../lib/agentSignIn';
import { ALL_CAPS, WATCH_CAPS, type Host } from '../../../lib/host/host';
import { HostProvider } from '../../../lib/host/context';
import { SignInFixCard } from '../../acp/SignInFixCard';
import { AgentList } from './AgentList';
import { standingWords, type AgentRow } from './useAgentRows';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const claude: AgentRow = { id: 'claude', label: 'Claude', icon: null, installed: true, state: 'needs_login', version: '2.1.0', loginHint: null, canTest: false, caps: null };

function fakeFar(proof = false) {
  const calls: string[] = [];
  const host: Host = {
    place: { kind: 'pc', node: 'aa', name: 'Linux box' },
    live: true,
    caps: WATCH_CAPS,
    listen: async () => () => undefined,
    invoke: async <T,>(cmd: string): Promise<T> => {
      calls.push(cmd);
      if (cmd === 'agent_login_states') return [{ agent_id: 'claude', state: 'signed_out', why: null }] as T;
      if (cmd === 'agent_signin_start') return { pane_id: 'hidden-far' } as T;
      if (cmd === 'agent_signin_status') return { alive: true, asking: false, pane_id: 'hidden-far', signed_in: proof } as T;
      if (cmd === 'agent_signin_stop') return undefined as T;
      throw new Error(`unexpected ${cmd}`);
    },
  };
  return { host, calls };
}

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function mount(host: Host) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => {
    root!.render(
      <HostProvider host={host}>
        <AgentList rows={[claude]} onOpen={() => undefined} />
      </HostProvider>,
    );
  });
  await act(async () => undefined);
  return el;
}

describe('a signed-out agent on another PC', () => {
  it('shows the same card words as on this PC, from that PC\'s own login state', async () => {
    const { host, calls } = fakeFar();
    const el = await mount(host);
    const card = el.querySelector('[data-testid="agent-row-claude"]')!;
    expect(card.textContent).toContain(standingWords(claude));
    expect(card.textContent).toContain('Not signed in');
    expect(card.querySelector('[data-testid="card-signin-claude"]')!.textContent).toBe('Sign in');
    expect(calls).toContain('agent_login_states');
    // This PC's extra accounts are never listed on it, so Sign out cannot touch one.
    expect((card.querySelector('[data-testid="card-signout-claude"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Sign in starts the sign-in on the far PC and nothing on this one', async () => {
    const { host, calls } = fakeFar();
    const el = await mount(host);
    await act(async () => (el.querySelector('[data-testid="card-signin-claude"]') as HTMLButtonElement).click());
    expect(calls).toContain('agent_signin_start');
    expect(el.querySelector('[data-testid="agent-row-claude"]')!.getAttribute('data-signin')).toBe('open');
  });
});

describe('the far sign-in proof', () => {
  it('counts only the far PC\'s own proof, never this PC\'s usage', async () => {
    const out = fakeFar(false);
    await expect(signInFor(out.host).check('claude')).rejects.toThrow('not finished');
    expect(out.calls).toEqual(['agent_signin_status']);
    const done = fakeFar(true);
    await expect(signInFor(done.host).check('claude')).resolves.toBeUndefined();
  });

  it('a local host keeps the module-level calls', () => {
    const local: Host = { place: { kind: 'local' }, live: true, caps: ALL_CAPS, invoke: vi.fn(), listen: async () => () => undefined };
    expect(signInFor(local).signIn('claude').start).toBeTypeOf('function');
  });
});

describe('the chat sign-in card step text', () => {
  const card = async (host: Host) => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
    const signIn = { start: async () => 'h', status: async () => ({ alive: true, asking: false, pane_id: 'h' }), stop: async () => undefined };
    await act(async () => {
      root!.render(
        <HostProvider host={host}>
          <SignInFixCard label="Claude" other={null} onOpen={() => undefined} onRetry={() => Promise.reject(new Error('x'))} onUseOther={() => undefined} signIn={signIn} />
        </HostProvider>,
      );
    });
    return el.querySelector('[data-testid="signin-steps"]')!.textContent ?? '';
  };

  it('says the browser opens on this PC and names the other PC on a far one', async () => {
    const local: Host = { place: { kind: 'local' }, live: true, caps: ALL_CAPS, invoke: vi.fn(), listen: async () => () => undefined };
    expect(await card(local)).toContain('Your browser opens.');
    act(() => root?.unmount());
    expect(await card(fakeFar().host)).toContain('runs on the other PC');
  });
});
