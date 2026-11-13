// @vitest-environment jsdom
// The "Saved. Theme: Light" toast with Undo, through the real Settings panel (a small catalog stands in for the pages).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@potato-workspace/shared';
import { BASE_SETTINGS, blur, click, settle, type as typeInto } from './test-utils';
import { fakeOverviewSources } from './overview-test-utils';

vi.mock('./catalog', async () => ({ SECTIONS: (await import('./changed-test-utils')).testSections() }));
vi.mock('../../lib/settings-recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/settings-recovery')>()),
  settingsRecoveryApi: { status: async () => ({ damaged: false, hasBackup: false }), restore: async () => undefined, dismiss: async () => undefined },
}));

import { SettingsPanel, type SettingsApi } from '../SettingsPanel';

let host: HTMLDivElement;
let root: Root;
let current: Settings;
let patch: ReturnType<typeof vi.fn>;

function makeApi(): SettingsApi {
  patch = vi.fn(async (change: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(change)) {
      if (v === null || v === undefined) delete (current as unknown as Record<string, unknown>)[k];
      else (current as unknown as Record<string, unknown>)[k] = v;
    }
    return { ...current };
  });
  return { load: vi.fn(async () => ({ ...current })), patch, findBridgeUrl: vi.fn(async () => null), subscribe: vi.fn(() => () => undefined) } as unknown as SettingsApi;
}

async function mount(initialTab: 'look' | 'keys' = 'look') {
  await act(async () => {
    root.render(<SettingsPanel open api={makeApi()} initialTab={initialTab} overviewSources={fakeOverviewSources()} />);
  });
  await settle(5);
}

const toast = () => host.querySelector('.st-toast') as HTMLElement | null;
const sw = (label: string) => host.querySelector(`[role="switch"][aria-label="${label}"]`) as HTMLButtonElement;
const undoButton = () => host.querySelector('.st-toast-undo') as HTMLButtonElement;

beforeEach(() => {
  current = { ...BASE_SETTINGS };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('the Undo toast', () => {
  it('a successful save shows the toast with the value in words and Undo', async () => {
    await mount();
    expect(toast()).toBeNull();
    await click(sw('Light theme'));
    await settle(3);
    expect(toast()?.textContent).toContain('Saved. Theme: Light');
    expect(toast()?.getAttribute('role')).toBe('status');
    expect(undoButton().textContent).toBe('Undo');
  });

  it('Undo puts the earlier values back with one patch', async () => {
    await mount();
    await click(sw('Light theme'));
    await settle(3);
    patch.mockClear();
    await click(undoButton());
    await settle(3);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith({ theme: 'dark' });
    expect(current.theme).toBe('dark');
    expect(toast()?.textContent).toBe('Put back.');
    expect(undoButton()).toBeNull(); // no second Undo
  });

  it('Ctrl+Z is Undo while the toast shows and no text field has focus', async () => {
    await mount();
    await click(sw('Light theme'));
    await settle(3);
    patch.mockClear();
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    });
    await settle(3);
    expect(patch).toHaveBeenCalledWith({ theme: 'dark' });
  });

  it('the toast leaves after 5 seconds and waits while it is hovered or focused', async () => {
    await mount();
    vi.useFakeTimers();
    await click(sw('Light theme'));
    await act(async () => void (await vi.advanceTimersByTimeAsync(4900)));
    expect(toast()).not.toBeNull();
    // The pointer on it: the clock stops.
    await act(async () => {
      toast()!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await act(async () => void (await vi.advanceTimersByTimeAsync(20000)));
    expect(toast()).not.toBeNull();
    await act(async () => {
      toast()!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    // Keyboard focus on Undo: the clock stops again.
    await act(async () => {
      undoButton().dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    await act(async () => void (await vi.advanceTimersByTimeAsync(20000)));
    expect(toast()).not.toBeNull();
    await act(async () => {
      undoButton().dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    await act(async () => void (await vi.advanceTimersByTimeAsync(4900)));
    expect(toast()).not.toBeNull();
    await act(async () => void (await vi.advanceTimersByTimeAsync(200)));
    expect(toast()).toBeNull();
  });

  it('a failed save shows the row error and no toast', async () => {
    await mount();
    patch.mockRejectedValueOnce(new Error('disk is full'));
    await click(sw('Light theme'));
    await settle(3);
    expect(toast()).toBeNull();
    expect((host.querySelector('[data-row="theme"] .st-rowerr') as HTMLElement).textContent).toContain('Not saved');
  });

  it('a failed Undo shows the row error', async () => {
    await mount();
    await click(sw('Light theme'));
    await settle(3);
    patch.mockRejectedValueOnce(new Error('disk is full'));
    await click(undoButton());
    await settle(3);
    expect((host.querySelector('[data-row="theme"] .st-rowerr') as HTMLElement).textContent).toContain('Not saved');
  });

  it('a second change replaces the first toast', async () => {
    await mount();
    await click(sw('Light theme'));
    await settle(3);
    const away = host.querySelector('input[aria-label="Away"]') as HTMLInputElement;
    await typeInto(away, '9');
    await blur(away);
    await settle(3);
    expect(host.querySelectorAll('.st-toast')).toHaveLength(1);
    expect(toast()?.textContent).toContain('Away digest: 9 minutes');
    expect(toast()?.textContent).not.toContain('Theme');
  });

  it('danger rows and key fields never get an Undo toast', async () => {
    await mount();
    await click([...host.querySelectorAll('[data-row="wipe"] button')].find((b) => b.textContent === 'Wipe')!);
    await settle(3);
    expect(patch).toHaveBeenCalledWith({ checkpoints_keep: 5 });
    expect(toast()).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount('keys');
    const key = host.querySelector('input[aria-label="Key"]') as HTMLInputElement;
    await typeInto(key, 'sk-test-1234');
    await blur(key);
    await settle(3);
    expect(patch).toHaveBeenLastCalledWith({ anthropic_api_key: 'sk-test-1234' });
    expect(toast()).toBeNull();
    expect(host.textContent).not.toContain('sk-test-1234');
  });

  it('a text field saves once on blur, not on each key', async () => {
    await mount();
    const name = host.querySelector('input[aria-label="Name"]') as HTMLInputElement;
    await typeInto(name, 'R');
    await typeInto(name, 'Re');
    await typeInto(name, 'Ren');
    expect(patch).not.toHaveBeenCalled();
    expect(toast()).toBeNull();
    await blur(name);
    await settle(3);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith({ display_name: 'Ren' });
    expect(host.querySelectorAll('.st-toast')).toHaveLength(1);
    expect(toast()?.textContent).toContain('Saved. Your name: Ren');
  });
});
