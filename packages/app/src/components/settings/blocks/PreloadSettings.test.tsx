// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STANDBY_CONFIG } from '../../../lib/standby';
import type { StandbyConfig, StandbyStatus } from '../../../lib/tauri-types';
import { PreloadSettings, type PreloadApi } from './PreloadSettings';
import type { AgentDescriptor } from '../../../lib/agentRegistry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The registry is the offline fallback unless a test sets `registryOverride`.
const registryOverride = vi.hoisted(() => ({ agents: null as AgentDescriptor[] | null }));
vi.mock('../../../lib/agentRegistry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/agentRegistry')>();
  return {
    ...real,
    useAgentRegistry: () => {
      const listing = real.useAgentRegistry();
      return registryOverride.agents ? { ...listing, agents: registryOverride.agents } : listing;
    },
  };
});

function statusFor(config: StandbyConfig): StandbyStatus {
  return {
    enabled: config.preload.enabled,
    config,
    counts: { total: 0, ready: 0, starting: 0 },
    standbys: [],
    blocked: [],
    recent: [],
    stats: { spawned: 0, spawn_failed: 0, claimed: 0, missed: 0, discarded: 0, expired: 0, abandoned: 0 },
    supported: [],
  };
}

function mockApi(initial: StandbyConfig = DEFAULT_STANDBY_CONFIG) {
  let current = initial;
  const api = {
    getStatus: vi.fn(async () => statusFor(current)),
    setConfig: vi.fn(async (next: StandbyConfig) => {
      current = next;
      return statusFor(current);
    }),
  };
  return api satisfies PreloadApi;
}

let host: HTMLDivElement;
let root: Root;

async function render(api: PreloadApi) {
  await act(async () => {
    root.render(<PreloadSettings api={api} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  // The agents and the idle time sit under "Details" (closed on a first look); open it for these tests.
  const details = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Details');
  if (details) await click(details);
}

const checkbox = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

/** Types into a React-controlled input: focus, set the value natively, fire `input` (as a keyboard would). */
async function typeInto(el: HTMLInputElement | null, text: string) {
  expect(el).toBeTruthy();
  await act(async () => {
    el!.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text);
    el!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Leaves a field, which saves a number field (it commits on blur). */
async function blur(el: HTMLElement | null) {
  expect(el).toBeTruthy();
  await act(async () => {
    el!.blur();
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  registryOverride.agents = null;
});

describe('PreloadSettings', () => {
  it("says why an agent couldn't stay warm", async () => {
    const api = mockApi();
    api.getStatus.mockResolvedValue({
      ...statusFor(DEFAULT_STANDBY_CONFIG),
      agents_blocked: [
        { agent_type: 'codex', reason: 'needs_attention', message: 'it stops at a login or update screen (finish that once yourself)', fails: 3, retry_in_ms: 0, cold: true },
      ],
    });
    await render(api);
    const line = host.querySelector('[data-testid="preload-blocked-codex"]');
    expect(line?.textContent).toContain("couldn't stay warm: it stops at a login or update screen");
    expect(line?.textContent).toContain('Not warming it until you open it.');
  });

  it('shows one short line with what to do, and keeps the long reason and the folders under More details', async () => {
    const api = mockApi();
    api.getStatus.mockResolvedValue({
      ...statusFor(DEFAULT_STANDBY_CONFIG),
      agents_blocked: [{ agent_type: 'claude', reason: 'dialog', message: 'it stops at a trust or approval prompt (open it once yourself first)', fails: 3, retry_in_ms: 0, cold: true }],
      blocked: [{ key: 'claude c:/work/tests', reason: 'dialog', fails: 3, retry_in_ms: 0, cold: true }],
    });
    await render(api);
    const short = host.querySelector('[data-testid="preload-short-claude"]')!;
    expect(short.textContent).toBe('Claude is not kept warm: it stops at a prompt. Open it once yourself and answer it.');
    const details = host.querySelector<HTMLDetailsElement>('[data-testid="preload-details"]')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('Held back:');
    expect(short.closest('details')).toBeNull();
  });

  it('has a Never close switch that saves, and a standby then says it stays ready', async () => {
    const api = mockApi();
    api.getStatus.mockResolvedValue({ ...statusFor(DEFAULT_STANDBY_CONFIG), standbys: [{ id: 's1', agent_type: 'claude', project: 'D:/x', state: 'ready', headless: false, idle_expires_in_ms: 60000 } as never] });
    const helpersApi = { get: vi.fn(async () => ({ helpers: [], max: 4, idle_minutes: 30, never_close: false })), setNeverClose: vi.fn(async (on: boolean) => ({ helpers: [], max: 4, idle_minutes: 30, never_close: on })) } as never;
    await act(async () => {
      root.render(<PreloadSettings api={api} helpersApi={helpersApi} />);
    });
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
    expect(host.textContent).toContain('sleeps in 1m');
    const toggle = [...host.querySelectorAll('[role="switch"]')].find((s) => s.closest('div')?.parentElement?.textContent?.includes('Never close') || s.getAttribute('aria-label') === 'Never close') as HTMLElement;
    await click(toggle);
    expect((helpersApi as { setNeverClose: ReturnType<typeof vi.fn> }).setNeverClose).toHaveBeenCalledWith(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.textContent).toContain('stays ready');
    expect(host.textContent).not.toContain('sleeps in');
  });

  it('shows which folder warm agents follow and why', async () => {
    const api = mockApi();
    api.getStatus.mockResolvedValue({
      ...statusFor(DEFAULT_STANDBY_CONFIG),
      following: { project: 'D:\\pm-workspace', why: 'run', not_warmed: [] },
    });
    await render(api);
    expect(host.querySelector('[data-testid="preload-following"]')?.textContent).toBe('following: D:\\pm-workspace — your last run');
    expect(host.querySelector('[data-testid^="preload-not-warmed"]')).toBeNull();
    api.getStatus.mockResolvedValue({
      ...statusFor(DEFAULT_STANDBY_CONFIG),
      following: { project: 'D:\\new-app', why: 'focus', not_warmed: [{ agent_type: 'claude', reason: 'needs_trust' }] },
    });
    await act(async () => {
      root.render(<PreloadSettings api={{ ...api }} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="preload-following"]')?.textContent).toBe('following: D:\\new-app — the window you opened');
    const cold = host.querySelector('[data-testid="preload-not-warmed-claude"]');
    expect(cold?.textContent).toContain('not warmed: D:\\new-app needs trust once for Claude');
  });

  it('is off by default, explains the cost, and has no per-agent list (each agent page has its own)', async () => {
    await render(mockApi());
    const master = host.querySelector('[role="switch"]');
    expect(master?.getAttribute('aria-checked')).toBe('false');
    expect(host.textContent).toContain('stays open in the background, which uses memory');
    expect(checkbox('Keep Claude warm')).toBeNull();
    expect(host.querySelector('[data-testid="preload-providers"]')).toBeNull();
  });

  it('the one switch is saved through the api and keeps the first agent that can be warm at one', async () => {
    const api = mockApi();
    await render(api);
    await click(host.querySelector('[role="switch"]'));
    expect(api.setConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ preload: { enabled: true, providers: { claude: 1 } } }),
    );
    await click(host.querySelector('[role="switch"]'));
    expect(api.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ preload: expect.objectContaining({ enabled: false }) }));
  });

  it('the idle timeout is edited in minutes under Details', async () => {
    const api = mockApi({ ...DEFAULT_STANDBY_CONFIG, preload: { enabled: true, providers: { claude: 1 } } });
    await render(api);
    const idle = host.querySelector<HTMLInputElement>('input[aria-label="Preload idle timeout (minutes)"]');
    expect(idle?.value).toBe('20');
  });

  it('shows a 5 second timeout in seconds without rewriting it on render', async () => {
    const api = mockApi({ ...DEFAULT_STANDBY_CONFIG, idle_timeout_secs: 5 });
    await render(api);
    const seconds = host.querySelector<HTMLInputElement>('input[aria-label="Preload idle timeout (seconds)"]');
    expect(seconds?.value).toBe('5');
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Idle timeout unit"]')?.value).toBe('seconds');
    expect(api.setConfig).not.toHaveBeenCalled();
  });

  it('shows a 20 minute timeout in minutes', async () => {
    await render(mockApi({ ...DEFAULT_STANDBY_CONFIG, idle_timeout_secs: 1200 }));
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Preload idle timeout (minutes)"]')?.value).toBe('20');
  });

  it('a typed seconds value is saved on blur', async () => {
    const api = mockApi({ ...DEFAULT_STANDBY_CONFIG, idle_timeout_secs: 5 });
    await render(api);
    const seconds = host.querySelector<HTMLInputElement>('input[aria-label="Preload idle timeout (seconds)"]');
    await typeInto(seconds, '30');
    await blur(seconds);
    expect(api.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ idle_timeout_secs: 30 }));
  });
});
