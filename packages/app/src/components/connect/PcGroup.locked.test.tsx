// @vitest-environment jsdom
// Connect > Devices: Open on a PC of my account while the account route is paused: the page says until when (in the person's clock) and what
// to do next, and nothing else is claimed. An error that is not a pause still shows as it came.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined), toString: vi.fn(async () => '<svg xmlns="http://www.w3.org/2000/svg"/>') } }));
import type { AccountApi, AccountPcsReply } from '../../lib/account';
import { click, settle } from '../settings/test-utils';
import { lockedUntilOf, lockTime } from './accountLock';
import { fakeTunnel, harness, makeApi, stable, type Harness } from './connect-test-utils';

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(async () => {
  await h.unmount();
});
const host = { get textContent() { return document.body.textContent; }, querySelector: (sel: string) => document.querySelector(sel) };

const REPLY: AccountPcsReply = {
  available: true,
  signed_in: true,
  open_here: true,
  published: true,
  pcs: [{ id: 'pc1', name: 'Desk PC', status: 'online', online: true, last_seen_at: 0, created_at: 0, recent: false, node: 'a1'.repeat(32) }],
};

async function mountWith(openError: unknown) {
  const api = {
    pcs: async () => REPLY,
    openPc: async () => {
      throw openError;
    },
    setOpenHere: async () => undefined,
    dismissRemoved: async () => undefined,
    state: async () => ({ configured: true, signed_in: true, waiting: false, message: null, account: null, device_id: null }),
    devices: async () => ({ signed_in: true, devices: [] }),
    onChanged: async () => () => undefined,
  } as unknown as AccountApi;
  await h.mount(makeApi({ tunnel: fakeTunnel(stable('linked')).api, account: api }));
  await click(document.querySelector('[data-testid="account-pc-open-pc1"]'));
  await settle(3);
}

describe('Open while the account route is paused', () => {
  it('reads the time out of the marker and ignores other text', () => {
    const now = 1_700_000_000_000;
    expect(lockedUntilOf(`account_locked_until:${now + 60_000}`, now)).toBe(now + 60_000);
    // Kept between now and a day from now.
    expect(lockedUntilOf(`account_locked_until:${now + 10 * 24 * 3_600_000}`, now)).toBe(now + 24 * 3_600_000);
    expect(lockedUntilOf('account_locked_until:5', now)).toBe(now);
    // A pause whose time cannot be read is still a pause (0), never the raw text.
    expect(lockedUntilOf('account_locked_until:12345678901234567890', now)).toBe(0);
    expect(lockedUntilOf('account_locked_until:soon', now)).toBe(0);
    expect(lockedUntilOf('Could not reach that PC.')).toBeNull();
    expect(lockedUntilOf(new Error(`account_locked_until:${now}`), now)).toBe(now);
  });

  it('shows the time as HH:MM today and the day when it is not today', () => {
    const now = new Date(2026, 10, 18, 9, 0).getTime();
    expect(lockTime(new Date(2026, 10, 18, 14, 5).getTime(), now)).toBe('14:05');
    expect(lockTime(new Date(2026, 10, 19, 14, 5).getTime(), now)).toMatch(/14:05$/);
    expect(lockTime(new Date(2026, 10, 19, 14, 5).getTime(), now).length).toBeGreaterThan(5);
  });

  it('says paused until the time, that paired PCs still work, and the next step', async () => {
    const at = Date.now() + 2 * 3_600_000;
    await mountWith(`account_locked_until:${at}`);
    const box = host.querySelector('[data-testid="account-pcs-paused"]')!;
    expect(box).not.toBeNull();
    expect(box.textContent).toContain('Opening from your account is paused until');
    expect(box.textContent).toContain(lockTime(at));
    expect(box.textContent).toContain('Your paired PCs still work.');
    expect(box.textContent).toContain("If this wasn't you, change your account password.");
    expect(host.querySelector('[data-testid="account-pcs-error"]')).toBeNull();
  });

  it('a time that cannot be read shows the generic paused message, not the raw text', async () => {
    await mountWith('account_locked_until:99999999999999999999');
    const box = host.querySelector('[data-testid="account-pcs-paused"]')!;
    expect(box.textContent).toContain('paused for a while');
    expect(box.textContent).toContain("If this wasn't you");
    expect(host.textContent).not.toContain('account_locked_until');
  });

  it('any other error still shows as it came', async () => {
    await mountWith('Could not reach that PC.');
    expect(host.querySelector('[data-testid="account-pcs-error"]')!.textContent).toBe('Could not reach that PC.');
    expect(host.querySelector('[data-testid="account-pcs-paused"]')).toBeNull();
  });
});
