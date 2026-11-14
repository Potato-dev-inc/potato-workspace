// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentHealth } from '../../lib/agent-health';
import type { StartupDeps } from '../../lib/startup-check';
import { StartupCheckLine } from './StartupCheckLine';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
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

const claude = (over: Partial<AgentHealth> = {}): AgentHealth => ({ id: 'claude', label: 'Claude', state: 'ready', installed: true, version: '1', reason: '', install_hint: null, login_hint: null, can_test: true, ...over });
const deps = (over: Partial<StartupDeps> = {}): StartupDeps => ({
  agentHealth: async () => [claude()],
  bridgeUp: () => true,
  diskFreeBytes: async () => 100 * 1024 ** 3,
  updateReachable: async () => true,
  lanes: async () => ({ labs_enabled: true, agents: [{ id: 'claude' }] }) as never,
  settings: async () => ({ show_terminals: false }),
  ...over,
});

async function start(d: StartupDeps, signIn = vi.fn()) {
  await act(async () => root.render(<StartupCheckLine deps={d} bridgeUp={() => true} actions={{ signIn }} delayMs={4000} enabled />));
  return signIn;
}
const run = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('StartupCheckLine', () => {
  it('shows nothing at all when everything is fine, before and after the check', async () => {
    await start(deps());
    expect(host.querySelector('[data-testid="startup-check"]')).toBeNull();
    await run(5000);
    expect(host.querySelector('[data-testid="startup-check"]')).toBeNull();
    expect(host.textContent).toBe('');
  });

  it('waits a few seconds after the start, then shows one line with Sign in, which opens that agent sign-in', async () => {
    const signIn = await start(deps({ agentHealth: async () => [claude({ state: 'needs_login' })] }));
    await run(1000);
    expect(host.querySelector('[data-testid="startup-check"]')).toBeNull();
    await run(4000);
    const line = host.querySelector('[data-testid="startup-check"]')!;
    expect(line.textContent).toContain('Claude needs sign-in');
    expect(line.getAttribute('role')).toBe('status');
    // Never a blocking window.
    expect(host.querySelector('[role="dialog"], [aria-modal="true"]')).toBeNull();
    await act(async () => [...line.querySelectorAll('button')].find((b) => b.textContent === 'Sign in')!.click());
    expect(signIn).toHaveBeenCalledWith('claude');
  });

  it('says how many more there are, and the x hides the line', async () => {
    await start(deps({ agentHealth: async () => [claude({ state: 'needs_login' })], diskFreeBytes: async () => 1024 ** 3 }));
    await run(5000);
    const line = host.querySelector('[data-testid="startup-check"]')!;
    expect(line.textContent).toContain('(+1 more)');
    await act(async () => line.querySelector<HTMLButtonElement>('.sc-x')!.click());
    expect(host.querySelector('[data-testid="startup-check"]')).toBeNull();
  });

  it('a check that fails by itself never shows an error', async () => {
    await start(
      deps({
        agentHealth: async () => {
          throw new Error('boom');
        },
      }),
    );
    await run(5000);
    expect(host.textContent).toBe('');
  });

  it('does nothing outside the desktop app', async () => {
    const health = vi.fn(async () => [claude({ state: 'needs_login' })]);
    await act(async () => root.render(<StartupCheckLine deps={deps({ agentHealth: health })} bridgeUp={() => true} actions={{ signIn: vi.fn() }} enabled={false} />));
    await run(10_000);
    expect(health).not.toHaveBeenCalled();
  });
});
