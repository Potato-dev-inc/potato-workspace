// @vitest-environment jsdom
// The Settings page with the REAL catalog: the Agents tab shows the three helper rows together, the new one
// "Close helpers when their agent closes" among them, and its switch saves through its own command.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@potato-workspace/shared';
import { BASE_SETTINGS, click, pickOption, settle } from './settings/test-utils';
import { SettingsPanel, type SettingsApi } from './SettingsPanel';

const saved = vi.hoisted(() => ({ mode: 'always_show', keepOpen: true, closeWithAgent: true, mostAtOnce: 8 }));

vi.mock('../lib/agentRunMode', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/agentRunMode')>();
  return {
    ...real,
    tauriHelperAgentsApi: {
      get: vi.fn(async () => ({ mode: saved.mode })),
      set: vi.fn(async (mode: string) => ({ mode })),
      getKeepOpen: vi.fn(async () => ({ on: saved.keepOpen })),
      setKeepOpen: vi.fn(async (on: boolean) => ({ on })),
      getMostAtOnce: vi.fn(async () => ({ value: saved.mostAtOnce })),
      setMostAtOnce: vi.fn(async (value: number) => {
        saved.mostAtOnce = value;
        return { value };
      }),
      getCloseWithAgent: vi.fn(async () => ({ on: saved.closeWithAgent })),
      setCloseWithAgent: vi.fn(async (on: boolean) => {
        saved.closeWithAgent = on;
        return { on };
      }),
    },
  };
});

let host: HTMLDivElement;
let root: Root;
let current: Settings;

function makeApi(): SettingsApi {
  return {
    load: vi.fn(async () => ({ ...current })),
    patch: vi.fn(async () => ({ ...current })),
    findBridgeUrl: vi.fn(async () => 'http://127.0.0.1:17321'),
    subscribe: vi.fn(() => () => undefined),
  };
}

const row = (id: string) => host.querySelector(`[data-row="${id}"]`);
const closeSwitch = () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Close helpers when their agent closes"]');

beforeEach(() => {
  current = { ...BASE_SETTINGS };
  saved.closeWithAgent = true;
  saved.mostAtOnce = 8;
  try {
    window.localStorage.clear();
  } catch {
    /* no storage */
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('Settings > Agents > Helpers on the real page', () => {
  it('shows "Close helpers when their agent closes" next to the other helper settings, on by default', async () => {
    await act(async () => {
      root.render(<SettingsPanel open api={makeApi()} initialTab="helpers" />);
    });
    await settle(10);
    expect(row('helper-agents')).not.toBeNull();
    expect(row('keep-helpers-open')).not.toBeNull();
    const closeRow = row('close-helpers-with-agent');
    expect(closeRow).not.toBeNull();
    expect(closeRow?.textContent).toContain('Close helpers when their agent closes');
    expect(closeSwitch()?.getAttribute('aria-checked')).toBe('true');
    // Same group, right after "Keep helpers open when they finish".
    expect(row('keep-helpers-open')?.nextElementSibling).toBe(closeRow);
  });

  it('turning it off saves through its own command', async () => {
    await act(async () => {
      root.render(<SettingsPanel open api={makeApi()} initialTab="helpers" />);
    });
    await settle(10);
    await click(closeSwitch());
    await settle(5);
    expect(saved.closeWithAgent).toBe(false);
    expect(closeSwitch()?.getAttribute('aria-checked')).toBe('false');
  });
});

describe('Settings > Agents > Helpers: Most helpers at once on the real page', () => {
  it('shows the row after the other helper settings, set to 8, and a change saves through its own command', async () => {
    await act(async () => {
      root.render(<SettingsPanel open api={makeApi()} initialTab="helpers" />);
    });
    await settle(10);
    // A rarely changed setting: it sits under Advanced until that is opened.
    expect(row('most-helpers-at-once')).toBeNull();
    await click(host.querySelector<HTMLButtonElement>('.st-adv-toggle'));
    await settle(10);
    const most = row('most-helpers-at-once');
    expect(most).not.toBeNull();
    expect(most?.textContent).toContain('Most helpers at once');
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Most helpers at once"]');
    expect(select?.value).toBe('8');
    await pickOption(select!, '4');
    await settle(5);
    expect(saved.mostAtOnce).toBe(4);
  });
});
