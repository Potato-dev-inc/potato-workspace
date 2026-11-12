// @vitest-environment jsdom
// The damaged-settings line on the Settings page: shown only when the file was damaged at start, and the buttons work.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buttonByText, click, hasText, settle } from './test-utils';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SettingsRecoveryApi, SettingsRecoveryStatus } from '../../lib/settings-recovery';
import { SettingsDamagedBanner } from './SettingsDamagedBanner';
import { SettingsRecoveryRow } from './sections/SettingsRecoveryRow';

let root: Root | null = null;
let host: HTMLElement | null = null;

function api(status: SettingsRecoveryStatus, restore: () => Promise<void> = async () => undefined): SettingsRecoveryApi & { restore: ReturnType<typeof vi.fn>; dismiss: ReturnType<typeof vi.fn> } {
  return { status: vi.fn(async () => status), restore: vi.fn(restore), dismiss: vi.fn(async () => undefined) };
}

async function mount(node: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  await settle(3);
  return host;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = host = null;
});

describe('the damaged-settings line', () => {
  it('shows nothing when the file was fine', async () => {
    const h = await mount(<SettingsDamagedBanner api={api({ damaged: false, hasBackup: true })} />);
    expect(h.textContent).toBe('');
  });

  it('says the file was damaged and restores the last good copy on a press', async () => {
    const a = api({ damaged: true, hasBackup: true });
    const h = await mount(<SettingsDamagedBanner api={a} />);
    expect(hasText(h, 'Your settings file was damaged')).toBe(true);
    await click(buttonByText(h, 'Restore the last good settings'));
    await settle(3);
    expect(a.restore).toHaveBeenCalledTimes(1);
    expect(h.textContent).toBe('');
  });

  it('cannot restore when no copy exists, and "Keep what I have" hides the line', async () => {
    const a = api({ damaged: true, hasBackup: false });
    const h = await mount(<SettingsDamagedBanner api={a} />);
    expect(buttonByText(h, 'Restore the last good settings')!.disabled).toBe(true);
    expect(hasText(h, 'no saved copy')).toBe(true);
    await click(buttonByText(h, 'Keep what I have'));
    await settle(3);
    expect(a.dismiss).toHaveBeenCalledTimes(1);
    expect(h.textContent).toBe('');
  });

  it('a failed restore says so in plain words and keeps the line', async () => {
    const a = api({ damaged: true, hasBackup: true }, async () => Promise.reject(new Error('Could not bring your settings back: disk full')));
    const h = await mount(<SettingsDamagedBanner api={a} />);
    await click(buttonByText(h, 'Restore the last good settings'));
    await settle(3);
    expect(hasText(h, 'disk full')).toBe(true);
    expect(hasText(h, 'Your settings file was damaged')).toBe(true);
  });
});

describe('Settings > General > About: Restore the last good settings', () => {
  it('has a button that restores, and is off when there is no copy', async () => {
    const a = api({ damaged: false, hasBackup: true });
    const h = await mount(<SettingsRecoveryRow api={a} />);
    await click(buttonByText(h, 'Restore the last good settings'));
    await settle(3);
    expect(a.restore).toHaveBeenCalledTimes(1);
    expect(hasText(h, 'Your settings are back')).toBe(true);
  });

  it('is disabled with a short note when no saved copy exists yet', async () => {
    const h = await mount(<SettingsRecoveryRow api={api({ damaged: false, hasBackup: false })} />);
    expect(buttonByText(h, 'Restore the last good settings')!.disabled).toBe(true);
    expect(hasText(h, 'No saved copy yet')).toBe(true);
  });
});
