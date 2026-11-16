// @vitest-environment jsdom
// The simple pickers on the real Settings page. The quiet hours row, the away digest and the agent limit are
// advanced rows (they show after "Advanced" is opened), so each test opens it first. In each row: quiet hours is one
// switch whose times sit behind "Change times"; the away digest is a short popup; the agent limit is one preset
// picker (Custom opens the numbers). There is no "Safety and limits" page yet, so the limit row is tested where it
// lives now (Agents > Limits).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@potato-workspace/shared';
import { BASE_SETTINGS, click, pickOption, settle } from './settings/test-utils';
import { QUIET_KEY } from '../lib/notify-store';
import { SettingsPanel, type SettingsApi } from './SettingsPanel';

let host: HTMLDivElement;
let root: Root;
let current: Settings;
let api: SettingsApi;

function makeApi(): SettingsApi {
  return {
    load: vi.fn(async () => ({ ...current })),
    patch: vi.fn(async (patch: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(patch)) (current as unknown as Record<string, unknown>)[k] = v;
      return { ...current };
    }),
    findBridgeUrl: vi.fn(async () => 'http://127.0.0.1:17321'),
    subscribe: vi.fn(() => () => undefined),
  };
}

async function mount(initialTab: string) {
  await act(async () => {
    root.render(<SettingsPanel open api={api} initialTab={initialTab as never} />);
  });
  await settle(5);
}

const row = (id: string) => host.querySelector<HTMLElement>(`[data-row="${id}"]`);
/** Number and time fields inside one row. */
const numericIn = (el: Element | null) => [...(el?.querySelectorAll<HTMLInputElement>('input') ?? [])].filter((i) => i.type === 'number' || i.type === 'time');
const select = (label: string) => host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
/** Opens the Advanced fold of the current page (the rows below it are not on a first look). */
async function openAdvanced() {
  const toggle = host.querySelector<HTMLButtonElement>('.st-adv-toggle');
  if (toggle && toggle.getAttribute('aria-expanded') === 'false') await click(toggle);
  await settle(3);
}

beforeEach(() => {
  current = { ...BASE_SETTINGS };
  try {
    window.localStorage.clear();
  } catch {
    /* no storage */
  }
  api = makeApi();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('Settings simple pickers', () => {
  it('Look and feel: the away digest and quiet hours rows hold no number or time field', async () => {
    await mount('look');
    await openAdvanced();
    expect(row('away-minutes')).not.toBeNull();
    expect(numericIn(row('away-minutes'))).toHaveLength(0);
    expect(numericIn(row('quiet-hours'))).toHaveLength(0);
  });

  it('the away digest is a popup of Off, 5, 15 and 30 minutes', async () => {
    await mount('look');
    await openAdvanced();
    const popup = select('Minutes away before I hear what happened (0 is off)');
    expect(popup).not.toBeNull();
    expect([...popup!.options].map((o) => o.value)).toEqual(['0', '5', '15', '30']);
    await act(async () => pickOption(popup!, '15'));
    await settle(3);
    expect(api.patch).toHaveBeenCalledWith({ away_minutes: 15 });
  });

  it('quiet hours is one switch: its times sit behind "Change times" once it is on', async () => {
    window.localStorage.setItem(QUIET_KEY, JSON.stringify({ enabled: true, start: 22 * 60, end: 8 * 60 }));
    await mount('look');
    await openAdvanced();
    expect(row('quiet-hours')?.textContent).toContain('Quiet at night (22:00 to 08:00)');
    expect(numericIn(row('quiet-hours'))).toHaveLength(0);
    expect(button('Change times')).toBeDefined();
    await click(button('Change times'));
    await settle(2);
    expect(numericIn(host).filter((el) => el.type === 'time')).toHaveLength(2);
  });

  it('the agent limit row is one preset picker with no number field until Custom is picked', async () => {
    await mount('agents');
    await openAdvanced();
    expect(numericIn(row('budget-turns'))).toHaveLength(0);
    const limit = select('How much an agent may use');
    expect(limit).not.toBeNull();
    expect(limit!.value).toBe('none');
    await act(async () => pickOption(limit!, 'heavy'));
    await settle(3);
    expect(api.patch).toHaveBeenCalledWith({ budget_default_turns: 1000, budget_default_minutes: 480 });
  });

  it('a saved set that matches no preset shows as Custom, with the two numbers', async () => {
    current = { ...current, budget_default_turns: 37, budget_default_minutes: 0 };
    await mount('agents');
    await openAdvanced();
    expect(select('How much an agent may use')!.value).toBe('custom');
    expect(numericIn(row('budget-turns'))).toHaveLength(2);
  });
});
