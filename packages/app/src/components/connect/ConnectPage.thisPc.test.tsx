// @vitest-environment jsdom
// Connect > Devices > "This PC": the states of the first row and the rate-limit rules of Fix it, through the real page.
// Only the command layers are fakes. The page checks by itself (no "Check now"), never restarts before Cloudflare's wait is over,
// stops offering Fix it after 3 presses, and never restarts on a different key.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../../i18n';
import type { TunnelStatus } from '../../lib/tauri-types';
import type { WorkerHealth } from '../../lib/worker';
import { click, settle } from '../settings/test-utils';
import { fakeTunnel, harness, makeApi, q, quick, stable, text, WORKER, type Harness } from './connect-test-utils';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined), toString: vi.fn(async () => '<svg xmlns="http://www.w3.org/2000/svg"/>') } }));

let h: Harness;
beforeEach(() => {
  window.localStorage.clear();
  setLanguagePref('en', false);
  h = harness();
});
afterEach(async () => {
  vi.useRealTimers();
  await h.unmount();
});

const state = () => q('[data-testid="connect-relay"]')!.getAttribute('data-state');
const fix = () => q<HTMLButtonElement>('[data-testid="connect-relay-fix"]');
const problem = () => text('[data-testid="connect-relay-problem-text"]');
const SENTENCE = "Your phone and other PCs can't reach this PC.";

describe('This PC: the states', () => {
  it('not set up: one button, and the setup runs from it (the row says it is setting up)', async () => {
    await h.mount(makeApi({ tunnel: fakeTunnel(quick()).api }));
    expect(state()).toBe('none');
    await click(q('[data-testid="relay-set-up"]'));
    await settle(4);
    expect(state()).toBe('setting-up');
    expect(text('[data-testid="connect-relay-status"]')).toBe('Setting this up…');
    expect(q('[data-testid="relay-sheet"]')).not.toBeNull();
  });

  it('getting ready, then working: plain words, the link and Copy', async () => {
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linking')).api }));
    expect(state()).toBe('starting');
    // No step and no port in this fixture: it says what is really known, never a bare "Getting ready".
    expect(text('[data-testid="connect-relay-status"]')).toBe('Nothing started yet. The phone server is not running.');
    await h.remount(makeApi({ tunnel: fakeTunnel(stable('linked')).api }));
    expect(state()).toBe('working');
    expect(text('[data-testid="connect-relay-status"]')).toBe('Works anywhere');
  });

  it('the page checks by itself: a link that is ready on paper but cannot be reached shows as broken', async () => {
    const t = fakeTunnel(stable('linked'), undefined, { test: async () => ({ ok: false, url: WORKER, http_status: 0, latency_ms: 0, message: 'no' }) });
    await h.mount(makeApi({ tunnel: t.api }));
    expect(state()).toBe('broken');
    expect(problem()).toBe(SENTENCE);
    expect(q('[data-testid="relay-menu-check"]')).toBeNull();
  });

  it('a fresh address that fails the first outside check is re-checked by itself and turns green, with no Fix it press', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    let calls = 0;
    const test = async () => ({ ok: ++calls > 1, url: WORKER, http_status: calls > 1 ? 200 : 0, latency_ms: 0, message: '' });
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linked'), undefined, { test }).api }));
    expect(state()).toBe('broken');
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await settle(4);
    expect(calls).toBe(2);
    expect(state()).toBe('working');
    expect(fix()).toBeNull();
  });

  it('there is no Check now, no menu, no used-by line, no relay options', async () => {
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linked')).api }));
    expect(q('[data-testid="connect-relay-menu"]')).toBeNull();
    expect(q('[data-testid="connect-relay-used"]')).toBeNull();
    expect(q('[data-testid="connect-relay-options"]')).toBeNull();
    expect(q('[data-testid="connect-relay-checked"]')).toBeNull();
  });

  it('Copy copies the link and says Copied', async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s: string) => (writes.push(s), undefined) }, configurable: true });
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linked')).api }));
    await click(q('[data-testid="relay-menu-copy"]'));
    await settle(4);
    expect(writes).toEqual([WORKER]);
    expect(text('[data-testid="relay-menu-copy"]')).toBe('Copied');
  });
});

describe('This PC: Fix it keeps the rate-limit rules', () => {
  it('broken: one sentence and Fix it, which restarts WITHOUT trying anyway', async () => {
    const args: unknown[][] = [];
    const t = fakeTunnel(stable('failed'), () => stable('linked'), {
      restart: async (...a: unknown[]) => {
        args.push(a);
        return stable('linked');
      },
    });
    await h.mount(makeApi({ tunnel: t.api }));
    expect(state()).toBe('broken');
    expect(problem()).toBe(SENTENCE);
    await click(fix());
    await settle(4);
    expect(args).toEqual([[]]);
    expect(state()).toBe('working');
  });

  it('Cloudflare asked to wait: the plain wait sentence, and Fix it is off until it ends', async () => {
    const waiting = { ...stable('failed'), problem: 'too_soon', retry_in_secs: 240 } as TunnelStatus;
    let restarts = 0;
    await h.mount(makeApi({ tunnel: fakeTunnel(waiting, undefined, { restart: async () => (restarts++, waiting) }).api }));
    expect(problem()).toBe('Cloudflare asked us to wait. Try again in about 4 min.');
    expect(fix()!.disabled).toBe(true);
    await click(fix());
    expect(restarts).toBe(0);
  });

  it('a problem word with no wait time left (the wait is over): no countdown, Fix it is on', async () => {
    const over = { ...stable('failed'), problem: 'too_soon', retry_in_secs: null } as TunnelStatus;
    await h.mount(makeApi({ tunnel: fakeTunnel(over).api }));
    expect(fix()!.disabled).toBe(false);
    expect(problem()).toBe(SENTENCE);
  });

  it('the wait counts down and Fix it turns back on when it ends (fake clock)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const t0 = Date.now();
    // Like the backend: every read says how much of the wait is left, and nothing once it is over.
    const read = async () => {
      const left = 60 - Math.floor((Date.now() - t0) / 1000);
      return { ...stable('failed'), problem: 'too_soon', retry_in_secs: left > 0 ? left : null } as TunnelStatus;
    };
    await h.mount(makeApi({ tunnel: fakeTunnel(await read(), undefined, { getStatus: read }).api }));
    expect(fix()!.disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(fix()!.disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(35_000);
    });
    expect(fix()!.disabled).toBe(false);
    expect(problem()).toBe(SENTENCE);
  });

  it('rate limited: its own sentence with the wait, button off', async () => {
    const limited = { ...stable('failed'), problem: 'rate_limited', retry_in_secs: 3600 } as TunnelStatus;
    await h.mount(makeApi({ tunnel: fakeTunnel(limited).api }));
    expect(problem()).toBe('Your network is limited for now. Try again in about 60 min.');
    expect(fix()!.disabled).toBe(true);
  });

  it('after 3 presses it stops offering Fix it and offers Set up again, which opens the setup (never a restart)', async () => {
    let restarts = 0;
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('failed'), undefined, { restart: async () => (restarts++, stable('failed')) }).api }));
    for (let i = 0; i < 3; i++) {
      await click(fix());
      await settle(4);
    }
    expect(restarts).toBe(3);
    expect(fix()).toBeNull();
    expect(problem()).toBe('This needs a fresh setup. Your phone will need to scan again.');
    await click(q('[data-testid="connect-relay-again"]'));
    await settle(4);
    expect(restarts).toBe(3);
    expect(q('[data-testid="relay-sheet"]')).not.toBeNull();
  });

  it('the 3 presses start over once it works again', async () => {
    let current = stable('failed');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('failed'), undefined, { getStatus: async () => current, restart: async () => current }).api }));
    for (let i = 0; i < 3; i++) {
      await click(fix());
      await settle(4);
    }
    expect(fix()).toBeNull();
    current = stable('linked');
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await settle(4);
    expect(state()).toBe('working');
    current = stable('failed');
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await settle(4);
    expect(state()).toBe('broken');
    expect(fix()).not.toBeNull();
    expect(problem()).toBe(SENTENCE);
  });

  it('a different key (secret mismatch): a fresh setup is offered, a restart never happens', async () => {
    const mismatch = { ...stable('failed'), stable: { worker_url: WORKER, quick_url: null, link: 'failed', error: 'refused', secret_mismatch: true } } as TunnelStatus;
    const t = fakeTunnel(mismatch);
    await h.mount(makeApi({ tunnel: t.api }));
    expect(problem()).toBe('This needs a fresh setup. Your phone will need to scan again.');
    expect(fix()).toBeNull();
    await click(q('[data-testid="connect-relay-again"]'));
    await settle(6);
    expect(t.calls.restart).toBe(0);
    expect(q('[data-testid="relay-sheet"]')).not.toBeNull();
  });
});

const withStep = (link: 'linking' | 'waiting', step: unknown, over: Partial<TunnelStatus> = {}) => stable(link, { state: 'starting', step, ...over } as Partial<TunnelStatus>);
const failedWith = (reason: string, over: Partial<TunnelStatus> = {}) =>
  stable('failed', { stable: { worker_url: WORKER, quick_url: 'https://quick-one.trycloudflare.com', link: 'failed', error: 'x', reason }, ...over } as Partial<TunnelStatus>);

describe('This PC: what the app is doing right now', () => {
  it('shows the real step with its seconds instead of a bare "Getting ready"', async () => {
    const s = withStep('waiting', { code: 'waiting_for_address', elapsed_secs: 14 });
    await h.mount(makeApi({ tunnel: fakeTunnel(s).api }));
    expect(state()).toBe('starting');
    expect(text('[data-testid="connect-relay-status"]')).toBe('Waiting for Cloudflare to give an address… 14 s');
    expect(q('[data-testid="connect-relay-still"]')).toBeNull();
  });

  it('names the try and the next try while telling the relay, and the counter keeps ticking between reads (fake clock)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const t0 = Date.now();
    // Like the backend, every read carries the seconds the step has lasted.
    const read = async () => withStep('linking', { code: 'registering', elapsed_secs: 5 + Math.floor((Date.now() - t0) / 1000), retry: 2, next_in_secs: 8 });
    await h.mount(makeApi({ tunnel: fakeTunnel(await read(), undefined, { getStatus: read }).api }));
    expect(text('[data-testid="connect-relay-status"]')).toBe('Telling your relay where this PC is (try 2, next try in 8 s)… 5 s');
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    await settle(2);
    expect(text('[data-testid="connect-relay-status"]')).toContain('… 8 s');
  });

  it('after 45 s with nothing failed it says it is still working, and not before', async () => {
    await h.mount(makeApi({ tunnel: fakeTunnel(withStep('waiting', { code: 'starting_tunnel', elapsed_secs: 50 })).api }));
    expect(text('[data-testid="connect-relay-still"]')).toBe('Still working. Nothing is wrong yet.');
    await h.remount(makeApi({ tunnel: fakeTunnel(withStep('waiting', { code: 'starting_tunnel', elapsed_secs: 50 }, { problem: 'slow_start' })).api }));
    expect(q('[data-testid="connect-relay-still"]')).toBeNull();
  });
});

describe('This PC: the real reason', () => {
  it('a relay Cloudflare removed: says so, offers Set up again (never Fix it), and the button opens the setup', async () => {
    const t = fakeTunnel(failedWith('worker_gone'));
    await h.mount(makeApi({ tunnel: t.api }));
    expect(state()).toBe('broken');
    expect(problem()).toBe('Your relay was removed from Cloudflare, so it cannot be reached any more.');
    expect(fix()).toBeNull();
    expect(text('[data-testid="connect-relay-again"]')).toBe('Set up again');
    await click(q('[data-testid="connect-relay-again"]'));
    await settle(4);
    expect(t.calls.restart).toBe(0);
    expect(q('[data-testid="relay-sheet"]')).not.toBeNull();
  });

  it('the free daily limit: explains it with the reset time, no Fix it, and offers the temporary link', async () => {
    await h.mount(makeApi({ tunnel: fakeTunnel(failedWith('over_quota')).api }));
    expect(problem()).toContain("Cloudflare's free daily limit for your relay is used up. It resets at ");
    expect(fix()).toBeNull();
    expect(q('[data-testid="connect-relay-again"]')).toBeNull();
    expect(text('[data-testid="connect-relay-use-temp"]')).toBe('Use the temporary link');
  });

  it('Temporary link ignores a dead relay: the row works from the quick address and a small note names the relay', async () => {
    const dead = failedWith('worker_gone', { link_temporary: true, link_mode: 'temporary', state: 'running' } as Partial<TunnelStatus>);
    await h.mount(makeApi({ tunnel: fakeTunnel(dead).api }));
    expect(state()).toBe('working');
    expect(text('[data-testid="connect-relay-status"]')).toBe('Works anywhere');
    expect(text('[data-testid="connect-relay-note"]')).toBe('Your saved relay was removed from Cloudflare. The temporary link does not need it.');
    expect(q('[data-testid="connect-relay-fix"]')).toBeNull();
    expect(q('[data-testid="connect-relay-again"]')).toBeNull();
  });

  it('Temporary link while the address is still being made shows the step, not a failure', async () => {
    const s = failedWith('worker_gone', { link_temporary: true, link_mode: 'temporary', state: 'starting', step: { code: 'checking_outside', elapsed_secs: 4 } } as Partial<TunnelStatus>);
    await h.mount(makeApi({ tunnel: fakeTunnel(s).api }));
    expect(state()).toBe('starting');
    expect(text('[data-testid="connect-relay-status"]')).toBe('Checking that it works from outside… 4 s');
  });
});

describe('This PC: Temporary address and the tunnel-off dev build', () => {
  it('Temporary: the chip and Copy use the trycloudflare address, not the relay', async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s: string) => (writes.push(s), undefined) }, configurable: true });
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linked', { link_temporary: true, link_mode: 'temporary' } as Partial<TunnelStatus>)).api }));
    expect(text('[data-testid="connect-relay-host"]')).toBe('quick-one.trycloudflare.com');
    await click(q('[data-testid="relay-menu-copy"]'));
    await settle(4);
    expect(writes).toEqual(['https://quick-one.trycloudflare.com']);
  });

  it('Temporary with no quick address yet: empty chip, Copy off, never the relay', async () => {
    const s = stable('linked', { link_temporary: true, link_mode: 'temporary', stable: { worker_url: WORKER, quick_url: null, link: 'linked', error: null } } as Partial<TunnelStatus>);
    await h.mount(makeApi({ tunnel: fakeTunnel(s).api }));
    expect(state()).toBe('starting');
    expect(q('[data-testid="connect-relay-host"]')).toBeNull();
    const none = stable('linked', { link_temporary: true, link_mode: 'temporary', state: 'running', step: { code: 'connected', elapsed_secs: 1 }, stable: { worker_url: WORKER, quick_url: null, link: 'linked', error: null } } as Partial<TunnelStatus>);
    await h.remount(makeApi({ tunnel: fakeTunnel(none).api }));
    expect(text('[data-testid="connect-relay-host"]')).not.toContain('workers.dev');
  });

  it('a dev build with the tunnel off says so, with no spinner and no button', async () => {
    const off = stable('waiting', { state: 'stopped', step: { code: 'tunnel_off', elapsed_secs: 9 }, stable: { worker_url: WORKER, quick_url: null, link: 'waiting', error: null } } as Partial<TunnelStatus>);
    await h.mount(makeApi({ tunnel: fakeTunnel(off).api }));
    expect(state()).toBe('broken');
    expect(problem()).toBe('The tunnel is off in this dev build (it starts only when POTATO_WORKSPACE_TUNNEL=1).');
    expect(fix()).toBeNull();
    expect(q('[data-testid="connect-relay-again"]')).toBeNull();
    await h.remount(makeApi({ tunnel: fakeTunnel(off).api }));
    setLanguagePref('zh-TW', false);
    await h.remount(makeApi({ tunnel: fakeTunnel(off).api }));
    expect(problem()).toContain('POTATO_WORKSPACE_TUNNEL=1');
    expect(problem()).toContain('開發版');
  });
});

const steps = () => Array.from(document.querySelectorAll('[data-testid="connect-steps"] .cx-step')).map((li) => `${li.getAttribute('data-status')}:${li.textContent}`);
const running = { local_port: 17425, state: 'running' } as Partial<TunnelStatus>;

describe('This PC: the live checklist, one mode at a time', () => {
  it('permanent: each line has a real state, the one in progress counts seconds', async () => {
    const s = withStep('waiting', { code: 'waiting_for_address', elapsed_secs: 14 }, { ...running, state: 'starting', stable: { worker_url: WORKER, quick_url: null, link: 'waiting', error: null } } as Partial<TunnelStatus>);
    await h.mount(makeApi({ tunnel: fakeTunnel(s).api }));
    expect(steps()).toEqual([
      'waiting:Looking for your relay: pm-relay.maya.workers.dev',
      'done:The phone server is running',
      'done:The tunnel program is running',
      'doing:Waiting for Cloudflare to give an address… 14 s',
      'waiting:Telling your relay where this PC is',
      'waiting:Checking it works from outside',
      'waiting:Connected',
    ]);
  });

  it('permanent with a removed relay: the first line fails with the real reason', async () => {
    await h.mount(makeApi({ tunnel: fakeTunnel(failedWith('worker_gone', running)).api }));
    expect(steps()[0]).toBe('failed:Your relay was removed from Cloudflare');
    expect(steps().some((l) => l.includes('Telling your relay'))).toBe(false);
  });

  it('temporary: no relay lines, the plain address, then the outside check', async () => {
    const s = withStep('linking', { code: 'checking_outside', elapsed_secs: 3 }, { ...running, state: 'running', link_temporary: true, link_mode: 'temporary' } as Partial<TunnelStatus>);
    await h.mount(makeApi({ tunnel: fakeTunnel(s).api }));
    expect(steps()).toEqual([
      'done:Using the plain temporary address',
      'done:The phone server is running',
      'done:The tunnel program is running',
      'done:Got an address',
      'doing:Checking it works from outside… 3 s',
      'waiting:Connected',
    ]);
  });

  it('once everything works the list folds to Show steps, and the steps come back on a press', async () => {
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linked', running)).api }));
    expect(state()).toBe('working');
    expect(steps()).toEqual([]);
    await click(q('[data-testid="connect-steps-toggle"]'));
    expect(steps().at(-1)).toBe('done:Connected');
  });

  it('the tunnel off in a dev build: one failed line and the plain reason, not a spinner', async () => {
    const off = stable('waiting', { state: 'stopped', local_port: 17425, step: { code: 'tunnel_off', elapsed_secs: 9 } } as Partial<TunnelStatus>);
    await h.mount(makeApi({ tunnel: fakeTunnel(off).api }));
    expect(steps()).toEqual(['failed:The tunnel is off in this dev build (it starts only when POTATO_WORKSPACE_TUNNEL=1).']);
  });

  it('Details lists the last real events with their time, in words', async () => {
    const t0 = new Date(2026, 10, 20, 3, 41, 2).getTime();
    const s = stable('failed', {
      ...running,
      stable: { worker_url: WORKER, quick_url: 'https://quick-one.trycloudflare.com', link: 'failed', error: 'x', reason: 'worker_gone' },
      events: [
        { at_ms: t0, code: 'tunnel_started' },
        { at_ms: t0 + 5000, code: 'address', host: 'quick-one.trycloudflare.com' },
        { at_ms: t0 + 5100, code: 'relay_failed', reason: 'worker_gone' },
      ],
    } as Partial<TunnelStatus>);
    await h.mount(makeApi({ tunnel: fakeTunnel(s).api }));
    expect(q('[data-testid="connect-events"]')).toBeNull();
    await click(q('[data-testid="connect-details-toggle"]'));
    const lines = Array.from(document.querySelectorAll('[data-testid="connect-events"] li')).map((li) => li.textContent);
    expect(lines).toEqual(['03:41:02 started the tunnel program', '03:41:07 got address quick-one.trycloudflare.com', '03:41:07 relay: removed from Cloudflare']);
  });
});

describe('This PC: My domain', () => {
  const dom = (over: Partial<TunnelStatus> = {}) => stable('waiting', { link_mode: 'domain', own_domain: 'https://tmux.v7ren.xyz', own_domain_verified: false, local_port: 1420, state: 'running', ...over } as Partial<TunnelStatus>);
  const reply = (over: object) => ({ ok: false, url: '', http_status: 502, latency_ms: 5, message: 'x', ...over });

  it('shows what the Check found, in plain words, never "Getting ready"', async () => {
    const t = fakeTunnel(dom(), undefined, { setLinkMode: async () => dom(), checkDomain: async () => reply({ reason: 'bad_gateway', http_status: 502 }) });
    await h.mount(makeApi({ tunnel: t.api }));
    expect(text('[data-testid="connect-relay-status"]')).toBe('The address answered with HTTP 502, but it cannot reach this PC. Point it at http://127.0.0.1:1420');
    expect(steps()).toEqual(['done:The phone server is running', 'failed:The address answered with HTTP 502, but it cannot reach this PC. Point it at http://127.0.0.1:1420']);
  });

  it('not this PC, a name that does not resolve, and a timeout each say so', async () => {
    const cases: [object, string][] = [
      [{ reason: 'not_this_pc', http_status: 200 }, 'The address answered, but not from this PC. Point it at http://127.0.0.1:1420'],
      [{ reason: 'dns', http_status: null }, 'The name tmux.v7ren.xyz did not resolve'],
      [{ reason: 'timeout', http_status: null }, 'The address did not answer in time'],
    ];
    for (const [r, want] of cases) {
      await h.remount(makeApi({ tunnel: fakeTunnel(dom(), undefined, { setLinkMode: async () => dom(), checkDomain: async () => reply(r) }).api }));
      expect(text('[data-testid="connect-relay-status"]')).toBe(want);
    }
  });

  it('while the Check runs it says who it is asking and counts seconds', async () => {
    await h.mount(makeApi({ tunnel: fakeTunnel(dom(), undefined, { setLinkMode: async () => dom(), checkDomain: () => new Promise(() => undefined) }).api }));
    expect(text('[data-testid="connect-relay-status"]')).toMatch(/^Asking tmux\.v7ren\.xyz… \d+ s$/);
    expect(steps()[1]).toMatch(/^doing:Asking tmux\.v7ren\.xyz if it reaches this PC… \d+ s$/);
  });

  it('the phone server not running is the reason, in the first line', async () => {
    const t = fakeTunnel(dom({ local_port: null, port_problem: 'not_running' } as Partial<TunnelStatus>), undefined, { setLinkMode: async () => dom(), checkDomain: () => new Promise(() => undefined) });
    await h.mount(makeApi({ tunnel: t.api }));
    expect(steps()[0]).toBe('failed:The phone server is not running');
  });
});

describe('This PC: the old-link update and the languages', () => {
  const health = (features: string[]): ((a: string) => Promise<WorkerHealth | null>) => async () => ({ reachable: true, features, legacyLink: false }) as unknown as WorkerHealth;

  it('a link made before PCs could be added on other networks gets one Update button; a newer one shows nothing', async () => {
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linked')).api, settings: { far_pcs_enabled: true }, workerHealth: health(['team', 'stable-link']) }));
    expect(text('[data-testid="connect-relay-status"]')).toContain('Works anywhere · PCs on other networks need an update.');
    await click(q('[data-testid="connect-relay-pair-update-go"]'));
    await settle(4);
    expect(q('[data-testid="relay-sheet"]')).not.toBeNull();
    await h.remount(makeApi({ tunnel: fakeTunnel(stable('linked')).api, settings: { far_pcs_enabled: true }, workerHealth: health(['team', 'stable-link', 'pair']) }));
    expect(q('[data-testid="connect-relay-pair-update-go"]')).toBeNull();
  });

  it('speaks Traditional Chinese in all three states', async () => {
    setLanguagePref('zh-TW', false);
    await h.mount(makeApi({ tunnel: fakeTunnel(quick()).api }));
    expect(text('[data-testid="relay-set-up"]')).toBe('讓它隨處可用');
    await h.remount(makeApi({ tunnel: fakeTunnel(stable('linked')).api }));
    expect(text('[data-testid="connect-relay-status"]')).toBe('隨處可用');
    await h.remount(makeApi({ tunnel: fakeTunnel(stable('failed')).api }));
    expect(problem()).toBe('你的手機和其他電腦連不到這台電腦。');
    expect(text('[data-testid="connect-relay-fix"]')).toBe('修復');
  });
});
