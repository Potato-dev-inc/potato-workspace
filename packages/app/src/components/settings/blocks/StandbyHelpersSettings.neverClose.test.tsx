// @vitest-environment jsdom
// Settings > Standbys: the card text is short, the idle line says "sleep" (a standby wakes when needed), and the Never close
// switch saves and turns the idle minutes off.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StandbyHelpersApi, StandbyHelpersView } from '../../../lib/standbyHelpers';
import { StandbyHelpersSettings } from './StandbyHelpersSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('StandbyHelpersSettings', () => {
  it('says sleep, keeps the text short, and Never close saves and turns the minutes off', async () => {
    const view = (never: boolean): StandbyHelpersView => ({ helpers: [], max: 4, idle_minutes: 30, never_close: never });
    const api = { get: vi.fn(async () => view(false)), setNeverClose: vi.fn(async (on: boolean) => view(on)) } as unknown as StandbyHelpersApi;
    await act(async () => root.render(<StandbyHelpersSettings api={api} />));
    for (let i = 0; i < 3; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    const text = host.textContent!;
    expect(text).toContain('Put one to sleep after');
    expect(text).not.toContain('Close one nobody used for');
    expect(text).toContain('A sleeping standby wakes when a task needs it.');
    expect(text.length).toBeLessThan(900);
    const minutes = host.querySelector<HTMLInputElement>('input[aria-label="Minutes before an unused standby goes to sleep"]')!;
    expect(minutes.disabled).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Never close"]')!.click());
    for (let i = 0; i < 2; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect((api.setNeverClose as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(true);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Minutes before an unused standby goes to sleep"]')!.disabled).toBe(true);
  });
});
