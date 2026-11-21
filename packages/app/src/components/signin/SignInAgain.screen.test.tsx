// @vitest-environment jsdom
// Screen level: "Sign in again" from the Usage card's expired row. A small sheet opens over the cockpit, the sign-in runs in a
// hidden pane (the lend sign-in's method), and nothing is started in the main workspace: no agent, no pane, no sidebar row.
// After the sign-in works the Usage bar reads fresh numbers, so the "Sign-in expired" row clears, and the sheet closes.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSignIn } from '../../lib/chatMore';
import { closeSignInAgain, peekSignInAgain, signedInNow } from '../../lib/agentSignIn';
import type { UsageApi, UsageSnapshot } from '../../lib/usage';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('../../lib/settings', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/settings')>();
  return { ...real, loadSettings: async () => ({ ...(await real.loadSettings()), show_usage_bar: true }) };
});

import { UsageBar } from '../cockpit/UsageBar';
import { SignInAgainHost } from './SignInAgainHost';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const row = (state: 'expired' | 'ok') => ({
  agent_id: 'claude',
  label: 'Claude',
  account_id: null,
  account_label: null,
  state,
  reason: state === 'expired' ? 'The sign-in has expired. Press Sign in again to fix it.' : null,
  windows: state === 'ok' ? [{ name: '5-hour', used_percent: 12, minutes: 300, resets_at_ms: Date.now() + 3_600_000, reset_since: false }] : [],
  plan: null,
  observed_at_ms: null,
  limited_until_ms: null,
  page: null,
});
const snap = (state: 'expired' | 'ok'): UsageSnapshot => ({ refreshed_at_ms: Date.now(), rows: [row(state)] });

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
  closeSignInAgain();
  invoke.mockReset();
});

function fakes() {
  const driver: ChatSignIn = { start: vi.fn(async () => 'hidden-1'), status: vi.fn(async () => ({ alive: true, asking: false, pane_id: 'hidden-1' })), stop: vi.fn(async () => undefined) };
  let signedIn = false;
  const usage: UsageApi = {
    snapshot: vi.fn(async () => snap(signedIn ? 'ok' : 'expired')),
    openPage: async () => undefined,
    onChanged: async () => () => undefined,
  };
  return { driver, usage, signIn: () => (signedIn = true) };
}

async function mount(f: ReturnType<typeof fakes>) {
  await act(async () =>
    root.render(
      <>
        <UsageBar api={f.usage} />
        <SignInAgainHost
          driver={() => f.driver}
          check={async (agentId) => {
            const s = await f.usage.snapshot(true, true);
            if (s.rows.some((r) => r.agent_id === agentId && r.state === 'expired')) throw new Error('still out');
          }}
          pollMs={40}
          lookMs={40}
          closeMs={300}
        />
      </>,
    ),
  );
  await act(async () => {});
  await act(async () => {});
}

const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const sheet = () => host.querySelector('[data-testid="signin-again-sheet"]');
const text = (b: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent === b);

describe('Sign in again from the Usage card', () => {
  it('opens a small sheet, signs in through a hidden pane, starts no pane or agent, refreshes the row and closes', async () => {
    const f = fakes();
    await mount(f);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="usage-strip"]')!.click());
    expect(host.querySelector('.ck-usage-pop-row.is-expired')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="usage-sign-in-again"]')!.click());
    expect(peekSignInAgain()).toMatchObject({ agentId: 'claude', accountId: null });
    expect(sheet()).not.toBeNull();
    expect(sheet()!.closest('.lend-sheet')).not.toBeNull();
    // The sheet that holds the sign-in terminal is the wide one (about 80 columns), and it scrolls when the window is small.
    expect(sheet()!.closest('.lend-sheet')!.getAttribute('data-size')).toBe('term');
    // Two steps, no terminal in the main workspace: the sign-in's own terminal is folded away until it asks something.
    await act(async () => text('Sign in')!.click());
    expect(f.driver.start).toHaveBeenCalledTimes(1);
    expect(sheet()!.textContent).toContain('Waiting for you to finish');
    expect(invoke).not.toHaveBeenCalledWith('new_pane', expect.anything());
    expect(host.querySelector('[data-testid="signin-details"]')).not.toBeNull();
    // The person signs in; the card notices, the usage is read again and the row is fine.
    f.signIn();
    await wait(120);
    expect(sheet()!.textContent).toContain('Signed in');
    expect(f.driver.stop).toHaveBeenCalled();
    expect(host.querySelector('.ck-usage-chip.is-expired')).toBeNull();
    await wait(400);
    expect(sheet()).toBeNull();
  });

  it('closing the sheet stops the hidden pane and leaves the row as it was', async () => {
    const f = fakes();
    await mount(f);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="usage-strip"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="usage-sign-in-again"]')!.click());
    await act(async () => text('Sign in')!.click());
    await act(async () => text('Close')!.click());
    expect(sheet()).toBeNull();
    expect(f.driver.stop).toHaveBeenCalled();
  });

  it('a borrowed row has no Sign in again (it is the lender\'s sign-in)', async () => {
    const f = fakes();
    f.usage.snapshot = async () => ({ refreshed_at_ms: 0, rows: [{ ...row('expired'), link: 'borrowed' as const, account_label: 'Leo' }] });
    await mount(f);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="usage-strip"]')!.click());
    expect(host.querySelector('[data-testid="usage-sign-in-again"]')).toBeNull();
  });
});

describe('Sign in again for an agent nothing can check', () => {
  it('says plainly the app cannot check it and offers only Close, not a Try again promise', async () => {
    const f = fakes();
    f.usage.snapshot = async () => ({ refreshed_at_ms: 0, rows: [{ ...row('ok'), account_id: 'acc-1', state: 'unknown' as const, windows: [] }] });
    const real = (agentId: string, accountId?: string | null) => signedInNow(agentId, accountId, f.usage, async () => ({ signed_in: null }));
    await act(async () => {
      root.render(<SignInAgainHost driver={() => f.driver} check={real} pollMs={30} lookMs={30} giveUpMs={5000} closeMs={200} />);
    });
    await act(async () => {
      (await import('../../lib/agentSignIn')).openSignInAgain({ agentId: 'claude', label: 'Claude', accountId: 'acc-1' });
    });
    await act(async () => text('Sign in')!.click());
    await wait(150);
    expect(sheet()!.querySelector('[data-testid="signin-cannot-check"]')!.textContent).toContain('cannot check whether Claude is signed in');
    expect(text('Try again')).toBeUndefined();
    expect(text('Close')).toBeTruthy();
    expect(sheet()!.textContent).not.toContain('Signed in.');
  });
});

describe('Sign in again for an account: complete only when the sign-in really is', () => {
  // The Settings > Accounts case: one extra sign-in whose folder the agent has just started writing into. Its usage row is `unknown`
  // from then on, which used to be taken for "signed in" a few seconds later, before anything was typed.
  it('a row that is only `unknown` never says signed in; after the waiting ends it says not finished with Try again, and a real sign makes it done', async () => {
    const f = fakes();
    let credentialWritten = false;
    f.usage.snapshot = async () => ({ refreshed_at_ms: 0, rows: [{ ...row('ok'), account_id: 'acc-1', account_label: 'Work', state: 'unknown' as const, windows: [] }] });
    const real = (agentId: string, accountId?: string | null) => signedInNow(agentId, accountId, f.usage, async () => ({ signed_in: credentialWritten }));
    await act(async () => {
      root.render(<SignInAgainHost driver={() => f.driver} check={real} pollMs={30} lookMs={30} giveUpMs={200} closeMs={200} />);
    });
    await act(async () => {
      (await import('../../lib/agentSignIn')).openSignInAgain({ agentId: 'claude', label: 'Claude', accountId: 'acc-1' });
    });
    await act(async () => text('Sign in')!.click());
    // Far longer than a poll: nothing was typed, so the sheet must still be waiting.
    await wait(120);
    expect(sheet()!.textContent).toContain('Waiting for you to finish');
    expect(sheet()!.textContent).not.toContain('Signed in');
    // The waiting runs out: it says so plainly, never success, and offers Try again.
    await wait(300);
    expect(sheet()!.textContent).toContain('Not finished yet');
    expect(sheet()!.textContent).not.toContain('Signed in. You can close this.');
    expect(text('Try again')).toBeTruthy();
    await act(async () => text('Try again')!.click());
    expect(sheet()!.textContent).not.toContain('Signed in. You can close this.');
    // The person finishes signing in: the credential file is written, the next look sees it.
    credentialWritten = true;
    await wait(120);
    expect(sheet()!.textContent).toContain('Signed in. You can close this.');
    // The "still out" line of the earlier Try again does not stay next to "Signed in".
    expect(sheet()!.textContent).not.toContain('still out');
    expect(f.driver.stop).toHaveBeenCalled();
  });
});
