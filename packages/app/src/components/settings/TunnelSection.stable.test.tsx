// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TunnelStatus } from '../../lib/tauri-types';
import { TunnelSection, type TunnelApi } from './TunnelSection';
import { draftFromConfig, draftProblem, isStableMode, statusLine, toInput } from './tunnel-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WORKER = 'https://potato-stable-link.me.workers.dev';
const quick: TunnelStatus = {
  mode: 'quick',
  public_url: 'https://abc.trycloudflare.com',
  state: 'running',
  error: null,
  config: { mode: 'quick', hostname: null, url: null, has_token: false },
};
const stable = (link: 'waiting' | 'linking' | 'linked' | 'failed', error: string | null = null): TunnelStatus => ({
  mode: 'stable',
  public_url: WORKER,
  state: 'running',
  error: null,
  config: { mode: 'stable', hostname: null, url: WORKER, has_token: false, has_secret: true },
  stable: { worker_url: WORKER, quick_url: 'https://abc.trycloudflare.com', link, error },
});

describe('stable link model', () => {
  it('needs a Worker address, and a typed secret must be long enough', () => {
    const draft = { ...draftFromConfig(quick.config), mode: 'stable' as const };
    expect(draftProblem(draft, quick.config)).toMatch(/Worker address/);
    expect(draftProblem({ ...draft, workerUrl: WORKER }, quick.config)).toBeNull();
    expect(draftProblem({ ...draft, workerUrl: WORKER, secret: 'short' }, quick.config)).toMatch(/16 characters/);
  });

  it('sends the address and keeps the stored secret when the field is blank', () => {
    const draft = { ...draftFromConfig(quick.config), mode: 'stable' as const, workerUrl: ` ${WORKER} `, secret: '' };
    expect(toInput(draft)).toEqual({ mode: 'stable', worker_url: WORKER, secret: null, secret_action: 'keep' });
    expect(toInput({ ...draft, secret: ' my-own-secret-123456 ' })).toMatchObject({ secret: 'my-own-secret-123456' });
  });

  it('reads the saved Worker address back into the draft and counts as a stable address', () => {
    expect(draftFromConfig(stable('linked').config)).toMatchObject({ mode: 'stable', workerUrl: WORKER, url: '' });
    expect(isStableMode('stable')).toBe(true);
  });

  it('says in plain words whether the Worker is linked', () => {
    expect(statusLine(stable('linked')).text).toBe(`Stable link: ${WORKER} → linked`);
    expect(statusLine(stable('linking')).tone).toBe('wait');
    const failed = statusLine(stable('failed', 'The secret does not match the one the Worker has.'));
    expect(failed.tone).toBe('bad');
    expect(failed.text).toBe(`Stable link: ${WORKER} → not linked yet (The secret does not match the one the Worker has.)`);
    expect(statusLine(stable('waiting')).text).toContain('waiting for the automatic address');
  });
});

describe('TunnelSection: stable link', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const flush = () => act(async () => { await Promise.resolve(); });
  const setValue = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  };
  const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label));

  function mockApi(initial: TunnelStatus, saved: TunnelStatus): TunnelApi & { save: ReturnType<typeof vi.fn> } {
    return {
      getStatus: vi.fn(async () => initial),
      save: vi.fn(async () => saved),
      restart: vi.fn(async () => initial),
      test: vi.fn(async () => ({ ok: true, url: 'u', http_status: 200, latency_ms: 42, message: 'Connected in 42 ms.' })),
    };
  }

  it('offers the fourth choice and saves the Worker address, then shows the new secret once', async () => {
    const api = mockApi(quick, { ...stable('linking'), secret_once: 'NEW-SECRET-VALUE-0123456789' });
    await act(async () => root.render(<TunnelSection api={api} />));
    await flush();
    const select = host.querySelector('select')!;
    expect([...select.options].map((o) => o.value)).toEqual(['quick', 'named', 'custom', 'stable']);
    expect([...select.options].at(-1)!.textContent).toBe('Stable link (your own Cloudflare Worker)');

    act(() => setValue(select, 'stable'));
    expect(host.textContent).toContain('relay/worker/README.md');
    expect(host.textContent).toContain('pair once again');
    expect(button('Save and restart')!.disabled).toBe(true); // no address yet
    act(() => setValue(host.querySelector('input[aria-label="Worker address"]')!, WORKER));
    expect(button('Save and restart')!.disabled).toBe(false);
    await act(async () => button('Save and restart')!.click());
    expect(api.save).toHaveBeenCalledWith({ mode: 'stable', worker_url: WORKER, secret: null, secret_action: 'keep' });
    await flush();
    expect(host.querySelector('[data-testid="stable-secret"]')?.textContent).toBe('NEW-SECRET-VALUE-0123456789');
    expect(host.querySelector('[data-testid="tunnel-status"]')?.textContent).toContain('linking');
    expect(host.querySelector('[data-testid="tunnel-url"]')?.textContent).toBe(WORKER);
    expect(host.querySelector('[data-testid="tunnel-quick-url"]')?.textContent).toContain('https://abc.trycloudflare.com');

    act(() => button('Hide')!.click());
    expect(host.textContent).not.toContain('NEW-SECRET-VALUE');
  });

  it('copies the secret with the Copy button', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const api = mockApi(quick, { ...stable('linked'), secret_once: 'COPY-ME-SECRET-0123456789' });
    await act(async () => root.render(<TunnelSection api={api} />));
    await flush();
    act(() => setValue(host.querySelector('select')!, 'stable'));
    act(() => setValue(host.querySelector('input[aria-label="Worker address"]')!, WORKER));
    await act(async () => button('Save and restart')!.click());
    await flush();
    await act(async () => button('Copy')!.click());
    expect(writeText).toHaveBeenCalledWith('COPY-ME-SECRET-0123456789');
    expect(button('Copied')).toBeTruthy();
  });

  it('with a saved link: shows the status line, never the stored secret, and "Show secret" / "Make a new secret" ask the app', async () => {
    const api = mockApi(stable('linked'), { ...stable('linked'), secret_once: 'SHOWN-ON-REQUEST-0123456789' });
    await act(async () => root.render(<TunnelSection api={api} />));
    await flush();
    expect(host.querySelector('[data-testid="tunnel-status"]')?.textContent).toBe(`Stable link: ${WORKER} → linked`);
    expect(host.textContent).not.toContain('SHOWN-ON-REQUEST');
    expect((host.querySelector('input[aria-label="Worker address"]') as HTMLInputElement).value).toBe(WORKER);

    await act(async () => button('Show secret')!.click());
    expect(api.save).toHaveBeenLastCalledWith({ mode: 'stable', worker_url: WORKER, secret_action: 'show' });
    await flush();
    expect(host.querySelector('[data-testid="stable-secret"]')?.textContent).toBe('SHOWN-ON-REQUEST-0123456789');

    await act(async () => button('Make a new secret')!.click());
    expect(api.save).toHaveBeenLastCalledWith({ mode: 'stable', worker_url: WORKER, secret_action: 'regenerate' });
  });

  it('shows "secret does not match" in the status line when the Worker refuses', async () => {
    const failed = stable('failed', 'The secret does not match the one the Worker has. Make a new secret, or reset the Worker.');
    await act(async () => root.render(<TunnelSection api={mockApi(failed, failed)} />));
    await flush();
    expect(host.querySelector('[data-testid="tunnel-status"]')?.textContent).toContain('not linked yet (The secret does not match');
  });
});
