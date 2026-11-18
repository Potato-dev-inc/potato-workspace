// @vitest-environment jsdom
// Connect > Devices > This PC: "Permanent link" / "Temporary link". One control on the existing card, no restart, the saved Worker stays,
// a plain note that phones on the other link must be added again. An own-domain Worker is a relay like a workers.dev one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../../i18n';
import type { TunnelStatus } from '../../lib/tauri-types';
import { click, settle } from '../settings/test-utils';
import { fakeTunnel, harness, makeApi, q, stable, text, type Harness } from './connect-test-utils';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined), toString: vi.fn(async () => '<svg xmlns="http://www.w3.org/2000/svg"/>') } }));

let h: Harness;
beforeEach(() => {
  window.localStorage.clear();
  setLanguagePref('en', false);
  h = harness();
});
afterEach(async () => {
  await h.unmount();
});

/** A tunnel whose switch behaves like the app's: it flips `link_temporary` and keeps the Worker setting and its link. */
function switchable(first: TunnelStatus) {
  let current = first;
  const seen: boolean[] = [];
  const t = fakeTunnel(first, undefined, {
    getStatus: async () => current,
    setTemporary: async (on: boolean) => {
      seen.push(on);
      current = { ...current, link_temporary: on };
      return current;
    },
  });
  return { ...t, seen };
}

describe('This PC: permanent or temporary link', () => {
  it('shows one switch with plain words, permanent by default, and no restart on a switch', async () => {
    const t = switchable(stable('linked'));
    await h.mount(makeApi({ tunnel: t.api }));
    expect(q('[data-testid="connect-link-mode"]')).not.toBeNull();
    expect(q('[data-testid="connect-link-permanent"]')!.getAttribute('aria-checked')).toBe('true');
    expect(text('[data-testid="connect-link-note"]')).toContain('same address');
    expect(q('[data-testid="connect-link-repair"]')).toBeNull();
    await click(q('[data-testid="connect-link-temporary"]'));
    await settle(4);
    expect(t.seen).toEqual([true]);
    expect(t.calls.restart).toBe(0);
    expect(q('[data-testid="connect-link-temporary"]')!.getAttribute('aria-checked')).toBe('true');
    expect(text('[data-testid="connect-link-note"]')).toContain('changes when this PC restarts');
    // the Worker is still the card's relay: its address stays, and the row still works
    expect(text('[data-testid="connect-relay-host"]')).toBe('pm-relay.maya.workers.dev');
    expect(q('[data-testid="connect-link-repair"]')!.textContent).toContain('added again');
  });

  it('switching back is one tap and the same note appears (phones on the other link need to be added again)', async () => {
    const t = switchable(stable('linked', { link_temporary: true }));
    await h.mount(makeApi({ tunnel: t.api }));
    expect(q('[data-testid="connect-link-temporary"]')!.getAttribute('aria-checked')).toBe('true');
    await click(q('[data-testid="connect-link-permanent"]'));
    await settle(4);
    expect(t.seen).toEqual([false]);
    expect(q('[data-testid="connect-link-permanent"]')!.getAttribute('aria-checked')).toBe('true');
    expect(q('[data-testid="connect-link-repair"]')).not.toBeNull();
  });

  it('pressing the mode that is already on does nothing', async () => {
    const t = switchable(stable('linked'));
    await h.mount(makeApi({ tunnel: t.api }));
    await click(q('[data-testid="connect-link-permanent"]'));
    await settle(2);
    expect(t.seen).toEqual([]);
  });

  it('no relay yet: no switch', async () => {
    const t = switchable({ ...stable('linked'), mode: 'quick', config: { mode: 'quick', hostname: null, url: null, has_token: false }, stable: null } as TunnelStatus);
    await h.mount(makeApi({ tunnel: t.api }));
    expect(q('[data-testid="connect-link-mode"]')).toBeNull();
  });

  it('a Worker on the own domain of the person is the relay too (nothing is tied to workers.dev)', async () => {
    const own = 'https://phone.example.com';
    const base = stable('linked');
    const t = switchable({ ...base, config: { ...base.config, url: own }, stable: { ...base.stable!, worker_url: own } });
    await h.mount(makeApi({ tunnel: t.api }));
    expect(q('[data-testid="connect-relay"]')!.getAttribute('data-state')).toBe('working');
    expect(text('[data-testid="connect-relay-host"]')).toBe('phone.example.com');
    expect(q('[data-testid="connect-link-mode"]')).not.toBeNull();
  });
});
