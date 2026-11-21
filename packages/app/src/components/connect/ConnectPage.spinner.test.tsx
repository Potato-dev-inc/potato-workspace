// @vitest-environment jsdom
// Connect > This PC: the spinner shows only while a step is really in progress. A reached, needs-update or failed state shows a still icon,
// in the row and in every checklist line. Through the real page; only the command layers are fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../../i18n';
import type { TunnelStatus } from '../../lib/tauri-types';
import { click, settle } from '../settings/test-utils';
import { fakeTunnel, harness, makeApi, q, stable, text, WORKER, type Harness } from './connect-test-utils';

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

const spinners = () => document.querySelectorAll('[data-testid="connect-relay"] [data-spinner], [data-testid="connect-relay"] .cx-dot.busy').length;
const rowIcon = () => q('[data-testid="connect-row-icon"]')?.getAttribute('data-icon');
const stepIcon = (id: string) => q(`.cx-step[data-step="${id}"] [data-icon]`)?.getAttribute('data-icon');
const reply = (over: object) => ({ ok: true, url: '', http_status: 200, latency_ms: 5, message: 'ok', ...over });
const running = { local_port: 17425, state: 'running' } as Partial<TunnelStatus>;
const failedRelay = (reason: string, quickUrl: string | null = 'https://quick-one.trycloudflare.com') =>
  stable('failed', { ...running, stable: { worker_url: WORKER, quick_url: quickUrl, link: 'failed', error: 'x', reason } } as Partial<TunnelStatus>);
const domain = (over: Partial<TunnelStatus> = {}) => stable('waiting', { link_mode: 'domain', own_domain: 'https://tmux.v7ren.xyz', own_domain_verified: false, local_port: 1420, state: 'running', ...over } as Partial<TunnelStatus>);

async function openSteps() {
  const toggle = q('[data-testid="connect-steps-toggle"]');
  if (toggle) await click(toggle);
}

describe('This PC: no spinner in a final state', () => {
  it('Permanent reached: a check, and every line still', async () => {
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linked', running)).api }));
    await openSteps();
    expect(q('[data-testid="connect-relay"]')!.getAttribute('data-state')).toBe('working');
    expect(rowIcon()).toBe('ok');
    expect(document.querySelectorAll('.cx-step').length).toBeGreaterThan(0);
    expect(spinners()).toBe(0);
  });

  it('Permanent with an old relay (needs an update): a warning, the plain sentence and Set up again, no spinner', async () => {
    await h.mount(makeApi({ tunnel: fakeTunnel(failedRelay('worker_too_old')).api }));
    expect(rowIcon()).toBe('warn');
    expect(text('[data-testid="connect-relay-problem-text"]')).toContain('Update your relay: press Set up again');
    expect(q('[data-testid="connect-relay-again"]')).not.toBeNull();
    expect(q('.cx-step[data-step="register"]')!.getAttribute('data-status')).toBe('warning');
    expect(stepIcon('register')).toBe('warn');
    expect(spinners()).toBe(0);
  });

  it('the event line for an old relay explains itself', async () => {
    const s = { ...failedRelay('worker_too_old'), events: [{ at_ms: Date.now(), code: 'relay_failed', reason: 'worker_too_old' }] } as TunnelStatus;
    await h.mount(makeApi({ tunnel: fakeTunnel(s).api }));
    await click(q('[data-testid="connect-details-toggle"]'));
    const line = text('[data-testid="connect-events"]');
    expect(line).toContain('Update your relay: press Set up again');
    expect(line).not.toMatch(/relay: it needs an update$/);
  });

  it('Permanent failed (removed relay): a cross, no spinner', async () => {
    await h.mount(makeApi({ tunnel: fakeTunnel(failedRelay('worker_gone', null)).api }));
    expect(stepIcon('relay')).toBe('bad');
    expect(rowIcon()).toBe('warn');
    expect(spinners()).toBe(0);
  });

  it('Temporary reached and Temporary not reached: still icons', async () => {
    const ok = stable('linked', { ...running, link_temporary: true, link_mode: 'temporary', step: { code: 'connected', elapsed_secs: 1 } } as Partial<TunnelStatus>);
    await h.mount(makeApi({ tunnel: fakeTunnel(ok).api }));
    await openSteps();
    expect(rowIcon()).toBe('ok');
    expect(spinners()).toBe(0);
    const bad = stable('linked', { ...running, link_temporary: true, link_mode: 'temporary', step: { code: 'not_reached', elapsed_secs: 1 } } as Partial<TunnelStatus>);
    await h.remount(makeApi({ tunnel: fakeTunnel(bad).api }));
    await openSteps();
    expect(stepIcon('outside')).toBe('bad');
    expect(spinners()).toBe(0);
  });

  it('My domain (Direct) reached while the saved flag still says not verified: a check, not a spinner', async () => {
    const t = fakeTunnel(domain(), undefined, { setLinkMode: async () => domain(), checkDomain: async () => reply({ reason: 'reached' }) });
    await h.mount(makeApi({ tunnel: t.api }));
    await settle(4);
    expect(text('[data-testid="connect-relay-status"]')).toBe('Reached this PC');
    expect(rowIcon()).toBe('ok');
    expect(spinners()).toBe(0);
  });

  it('My domain (Direct) failed: a warning and a cross, no spinner', async () => {
    const t = fakeTunnel(domain(), undefined, { setLinkMode: async () => domain(), checkDomain: async () => reply({ ok: false, reason: 'bad_gateway', http_status: 502 }) });
    await h.mount(makeApi({ tunnel: t.api }));
    await settle(4);
    expect(rowIcon()).toBe('warn');
    expect(stepIcon('ask')).toBe('bad');
    expect(spinners()).toBe(0);
  });

  it('My domain (Address book) reached, and with an old Worker: check, then warning', async () => {
    const book = (over: object) => domain({ link_route: 'book', book: { domain: 'https://tmux.v7ren.xyz', supported: true, has_address: true, link: 'linked', ...over } } as Partial<TunnelStatus>);
    const mk = (s: TunnelStatus, r: object) => fakeTunnel(s, undefined, { setLinkMode: async () => s, checkDomain: async () => reply(r) }).api;
    await h.mount(makeApi({ tunnel: mk(book({}), { reason: 'reached' }) }));
    await settle(4);
    expect(rowIcon()).toBe('ok');
    expect(spinners()).toBe(0);
    await h.remount(makeApi({ tunnel: mk(book({ link: 'failed', reason: 'worker_too_old' }), { ok: false, reason: 'no_worker', http_status: 404 }) }));
    await settle(4);
    expect(rowIcon()).toBe('warn');
    expect(q('.cx-step[data-step="register"]')!.getAttribute('data-status')).toBe('warning');
    expect(spinners()).toBe(0);
  });

  it('a step really in progress still spins (the spinner is not just removed)', async () => {
    const s = stable('waiting', { state: 'starting', step: { code: 'waiting_for_address', elapsed_secs: 4 }, stable: { worker_url: WORKER, quick_url: null, link: 'waiting', error: null } } as Partial<TunnelStatus>);
    await h.mount(makeApi({ tunnel: fakeTunnel(s).api }));
    expect(rowIcon()).toBe('busy');
    expect(spinners()).toBeGreaterThan(0);
  });

  it('zh-TW has the update sentence too', async () => {
    setLanguagePref('zh-TW', false);
    await h.mount(makeApi({ tunnel: fakeTunnel(failedRelay('worker_too_old', null)).api }));
    expect(text('[data-testid="connect-relay-problem-text"]')).toContain('重新設定');
  });
});
