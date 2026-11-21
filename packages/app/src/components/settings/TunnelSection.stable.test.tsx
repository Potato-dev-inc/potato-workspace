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
    expect(draftProblem(draft, quick.config)).toMatch(/link address/);
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
    expect([...select.options].at(-1)!.textContent).toBe('One fixed address (your own Cloudflare link)');

    act(() => setValue(select, 'stable'));
    expect(host.textContent).toContain('Set it up once with one button');
    expect(host.textContent).not.toMatch(/npm |wrangler|README/);
    expect(host.textContent).toContain('pair once again');
    expect(button('Save and restart')!.disabled).toBe(true); // no address yet
    act(() => setValue(host.querySelector('input[aria-label="Link address"]')!, WORKER));
    expect(button('Save and restart')!.disabled).toBe(false);
    await act(async () => button('Save and restart')!.click());
    expect(api.save).toHaveBeenCalledWith({ mode: 'stable', worker_url: WORKER, secret: null, secret_action: 'keep' });
    await flush();
    // Hidden by default: dots in the page, never the secret; the eye button shows it, and hides it again.
    expect(host.querySelector('[data-testid="stable-secret"]')?.textContent).toMatch(/^•+$/);
    expect(host.textContent).not.toContain('NEW-SECRET-VALUE');
    const eye = () => host.querySelector<HTMLButtonElement>('[data-testid="stable-secret-eye"]')!;
    expect(eye().getAttribute('aria-pressed')).toBe('false');
    act(() => eye().click());
    expect(host.querySelector('[data-testid="stable-secret"]')?.textContent).toBe('NEW-SECRET-VALUE-0123456789');
    expect(eye().getAttribute('aria-pressed')).toBe('true');
    act(() => eye().click());
    // Hiding forgets it: the value is gone from the page, and "Show secret" is the way back.
    expect(host.textContent).not.toContain('NEW-SECRET-VALUE');
    expect(host.querySelector('[data-testid="stable-secret"]')).toBeNull();
    expect(host.querySelector('[data-testid="tunnel-status"]')?.textContent).toContain('linking');
    expect(host.querySelector('[data-testid="tunnel-url"]')?.textContent).toBe(WORKER);
    expect(host.querySelector('[data-testid="tunnel-quick-url"]')?.textContent).toContain('https://abc.trycloudflare.com');

    expect(host.textContent).not.toContain('NEW-SECRET-VALUE');
  });

  it('copies the secret with the Copy button', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const api = mockApi(quick, { ...stable('linked'), secret_once: 'COPY-ME-SECRET-0123456789' });
    await act(async () => root.render(<TunnelSection api={api} />));
    await flush();
    act(() => setValue(host.querySelector('select')!, 'stable'));
    act(() => setValue(host.querySelector('input[aria-label="Link address"]')!, WORKER));
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
    expect((host.querySelector('input[aria-label="Link address"]') as HTMLInputElement).value).toBe(WORKER);

    await act(async () => button('Show secret')!.click());
    expect(api.save).toHaveBeenLastCalledWith({ mode: 'stable', worker_url: WORKER, secret_action: 'show' });
    await flush();
    // "Show secret" brings the secret to the page hidden; the eye button shows it.
    expect(host.textContent).not.toContain('SHOWN-ON-REQUEST');
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="stable-secret-eye"]')!.click());
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

  const mismatchStatus = (): TunnelStatus => ({
    ...stable('failed', 'The secret does not match the one the Worker has.'),
    stable: { worker_url: WORKER, quick_url: 'https://abc.trycloudflare.com', link: 'failed', error: 'The secret does not match the one the Worker has.', secret_mismatch: true },
  });

  it('shows a recovery card when the Worker has another secret: paste the first secret (hidden, eye) or start fresh', async () => {
    const api = mockApi(mismatchStatus(), stable('linking'));
    await act(async () => root.render(<TunnelSection api={api} />));
    await flush();
    const card = () => host.querySelector('[data-testid="secret-recovery"]');
    expect(card()?.textContent).toContain('Paste the first secret you saved');
    expect(card()?.textContent).toContain('Nothing is deleted on Cloudflare');
    // Option 1: hidden by default, the eye shows it, a short one cannot be used.
    const field = () => host.querySelector<HTMLInputElement>('[data-testid="recover-secret"]')!;
    expect(field().type).toBe('password');
    act(() => setValue(field(), 'short'));
    expect(host.querySelector<HTMLButtonElement>('[data-testid="recover-use"]')!.disabled).toBe(true);
    act(() => setValue(field(), 'the-first-secret-0123456789'));
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="recover-secret-eye"]')!.click());
    expect(field().type).toBe('text');
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="recover-use"]')!.click());
    expect(api.save).toHaveBeenLastCalledWith({ mode: 'stable', worker_url: WORKER, secret: 'the-first-secret-0123456789', secret_action: 'keep' });
    await flush();
    expect(host.textContent).not.toContain('the-first-secret');
    expect(card()).toBeNull(); // linked again: the card goes away
  });

  it('"Start fresh" asks first, then forgets the saved link on this computer only and leaves a blank Worker address', async () => {
    const api = mockApi(mismatchStatus(), quick);
    await act(async () => root.render(<TunnelSection api={api} />));
    await flush();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="recover-fresh"]')!.click());
    expect(api.save).not.toHaveBeenCalled(); // only a question so far
    expect(host.querySelector('[data-testid="recover-fresh-confirm"]')?.textContent).toContain('Forget the saved link on this computer?');
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="recover-fresh-yes"]')!.click());
    expect(api.save).toHaveBeenCalledWith({ mode: 'forget_worker' });
    await flush();
    expect(host.querySelector('[data-testid="secret-recovery"]')).toBeNull();
    expect((host.querySelector('input[aria-label="Link address"]') as HTMLInputElement).value).toBe('');
  });

  it('keeps the recovery card away while the link is fine', async () => {
    await act(async () => root.render(<TunnelSection api={mockApi(stable('linked'), stable('linked'))} />));
    await flush();
    expect(host.querySelector('[data-testid="secret-recovery"]')).toBeNull();
  });

  it('"Make a new secret" that the Worker cannot honour is held back: warn in plain words, then confirm or keep the old secret', async () => {
    const held: TunnelStatus = { ...stable('linked'), secret_not_reset: 'rejected' };
    const api = mockApi(stable('linked'), held);
    await act(async () => root.render(<TunnelSection api={api} />));
    await flush();
    await act(async () => button('Make a new secret')!.click());
    expect(api.save).toHaveBeenLastCalledWith({ mode: 'stable', worker_url: WORKER, secret_action: 'regenerate' });
    await flush();
    expect(host.querySelector('[data-testid="strand-warning"]')?.textContent).toContain('different secret');
    // Confirm: the same save, with the go-ahead.
    api.save.mockResolvedValueOnce({ ...stable('linking'), secret_once: 'MADE-AFTER-CONFIRM-0123456789' });
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="strand-go"]')!.click());
    expect(api.save).toHaveBeenLastCalledWith({ mode: 'stable', worker_url: WORKER, secret_action: 'regenerate', confirm_strand: true });
    await flush();
    expect(host.querySelector('[data-testid="strand-warning"]')).toBeNull();
    expect(host.textContent).not.toContain('MADE-AFTER-CONFIRM');
    // Keep: the warning closes and nothing is saved.
    await act(async () => button('Make a new secret')!.click());
    await flush();
    const calls = api.save.mock.calls.length;
    api.save.mockResolvedValue(held);
    await act(async () => button('Make a new secret')!.click());
    await flush();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="strand-keep"]')!.click());
    expect(host.querySelector('[data-testid="strand-warning"]')).toBeNull();
    expect(api.save.mock.calls.length).toBeGreaterThan(calls);
  });

  it('an app too old for the Worker, or too many tries, says so and never offers "Make it anyway"', async () => {
    for (const [reason, words] of [['update_app', 'newer version'], ['too_many', 'Too many tries']] as const) {
      const api = mockApi(stable('linked'), { ...stable('linked'), secret_not_reset: reason });
      await act(async () => root.render(<TunnelSection api={api} />));
      await flush();
      await act(async () => button('Make a new secret')!.click());
      await flush();
      expect(host.querySelector('[data-testid="strand-warning"]')?.textContent).toContain(words);
      expect(host.querySelector('[data-testid="strand-go"]')).toBeNull();
      expect(host.querySelector('[data-testid="strand-keep"]')).not.toBeNull();
    }
  });

  it('after a paste it keeps polling: a wrong secret brings the recovery card back, a right one ends in linked', async () => {
    vi.useFakeTimers();
    try {
      for (const right of [false, true]) {
        const api = mockApi(mismatchStatus(), stable('linking'));
        (api.getStatus as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce(mismatchStatus()) // first load
          .mockResolvedValueOnce(stable('linking'))
          .mockResolvedValue(right ? stable('linked') : mismatchStatus());
        await act(async () => root.render(<TunnelSection api={api} />));
        await act(async () => { await Promise.resolve(); });
        act(() => setValue(host.querySelector('[data-testid="recover-secret"]')!, 'a-pasted-secret-0123456789'));
        await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="recover-use"]')!.click());
        expect(host.querySelector('[data-testid="secret-recovery"]')).toBeNull(); // linking now
        await act(async () => { await vi.advanceTimersByTimeAsync(3200); });
        if (right) {
          expect(host.querySelector('[data-testid="tunnel-status"]')?.textContent).toContain('→ linked');
          expect(host.querySelector('[data-testid="secret-recovery"]')).toBeNull();
        } else {
          expect(host.querySelector('[data-testid="secret-recovery"]')).not.toBeNull();
          expect((host.querySelector('[data-testid="recover-secret"]') as HTMLInputElement).value).toBe('');
        }
        act(() => root.unmount());
        root = createRoot(host);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling after about a minute and says it is still linking', async () => {
    vi.useFakeTimers();
    try {
      const api = mockApi(stable('linking'), stable('linking'));
      await act(async () => root.render(<TunnelSection api={api} />));
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(70000); });
      expect(host.querySelector('[data-testid="tunnel-still-linking"]')?.textContent).toContain('Still linking');
      const calls = (api.getStatus as ReturnType<typeof vi.fn>).mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect((api.getStatus as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});
