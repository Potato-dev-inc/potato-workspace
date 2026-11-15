// @vitest-environment jsdom
// "Notifications on this PC" (a Windows toast with buttons when something needs you): the switch on the Look and feel
// page, rendered through the real Settings screen. On by default; a change is saved on the PC, where the alerts leave from.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@potato-workspace/shared';
import { resetNotifyStoreForTest } from '../../lib/notify-store';
import { SettingsPanel, type SettingsApi } from '../SettingsPanel';
import { BASE_SETTINGS, settle } from './test-utils';

let desktopToasts: boolean | undefined = undefined;
const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  const base = { bells: {}, quiet: { enabled: false, start: 1320, end: 420 }, snoozes: {}, imported: true };
  if (cmd === 'notify_prefs_get') return desktopToasts === undefined ? base : { ...base, desktop_toasts: desktopToasts };
  if (cmd === 'notify_pc_set') return { ...base, desktop_toasts: (args as { enabled: boolean }).enabled };
  return null;
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...a) }));
vi.mock('../../lib/tauri', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/tauri')>();
  return { ...orig, tauri: { ...orig.tauri, autostartGet: vi.fn(async () => false), autostartSet: vi.fn(async () => undefined) } };
});

let host: HTMLDivElement;
let root: Root;

const api = (): SettingsApi => ({
  load: vi.fn(async () => ({ ...BASE_SETTINGS }) as Settings),
  patch: vi.fn(async () => ({ ...BASE_SETTINGS }) as Settings),
  findBridgeUrl: vi.fn(async () => 'http://127.0.0.1:17321'),
  subscribe: vi.fn(() => () => undefined),
});

async function openLook(): Promise<void> {
  await act(async () => {
    root.render(<SettingsPanel open initialTab="look" api={api()} onClose={() => undefined} />);
  });
  await settle(10);
  // Like Quiet hours, the row sits under the page's closed "Advanced" group.
  const fold = host.querySelector<HTMLButtonElement>('button.st-adv-toggle[aria-expanded="false"]');
  if (fold) await act(async () => fold.click());
  await settle(4);
}

const switchEl = (): HTMLButtonElement | null => host.querySelector('[data-row="pc-notifications"] [role="switch"]');

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  resetNotifyStoreForTest();
  desktopToasts = undefined;
  invoke.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});

describe('Notifications on this PC (Look and feel, While agents work)', () => {
  it('sits next to Quiet hours, with its own words', async () => {
    await openLook();
    const row = host.querySelector('[data-row="pc-notifications"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('Notifications on this PC');
    const rows = [...host.querySelectorAll('[data-row]')].map((r) => r.getAttribute('data-row'));
    expect(rows.indexOf('pc-notifications')).toBe(rows.indexOf('quiet-hours') + 1);
  });

  it('is on until the person turns it off, and asks nothing of the PC just to show', async () => {
    await openLook();
    expect(switchEl()?.getAttribute('aria-checked')).toBe('true');
    expect(invoke).not.toHaveBeenCalledWith('notify_pc_set', expect.anything());
  });

  it('turning it off is saved on the PC and the switch follows', async () => {
    await openLook();
    await act(async () => switchEl()!.click());
    await settle(4);
    expect(invoke).toHaveBeenCalledWith('notify_pc_set', { enabled: false });
    expect(switchEl()?.getAttribute('aria-checked')).toBe('false');
    await act(async () => switchEl()!.click());
    await settle(4);
    expect(invoke).toHaveBeenLastCalledWith('notify_pc_set', { enabled: true });
    expect(switchEl()?.getAttribute('aria-checked')).toBe('true');
  });

  it('shows off when the PC says it was turned off before', async () => {
    desktopToasts = false;
    await openLook();
    expect(switchEl()?.getAttribute('aria-checked')).toBe('false');
  });

  it('leaves the quiet hours switch alone', async () => {
    await openLook();
    await act(async () => switchEl()!.click());
    await settle(4);
    expect(invoke).not.toHaveBeenCalledWith('notify_quiet_set', expect.anything());
  });
});
