// @vitest-environment jsdom
// Screen level, in Traditional Chinese: the bar's own words ("Usage", the "working" and "need you" counts, "Refresh
// usage", "+N") and the popover's (its title, the usage page link, "% used", the meter names) are translated. The
// sign-in state and reset sentences come from lib/usage and are checked separately there; the window names are data.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageSnapshot } from '../../lib/usage';
import { t } from '../../i18n';
import { useChinese, useEnglish, visibleEnglish } from '../../i18n/test-utils';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

vi.mock('../../lib/settings', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/settings')>();
  return { ...real, loadSettings: async () => ({ ...(await real.loadSettings()), show_usage_bar: true }) };
});

import { UsageBar } from './UsageBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const H = 3_600_000;
const NOW = Date.now();

const SNAP: UsageSnapshot = {
  refreshed_at_ms: NOW,
  rows: [
    {
      agent_id: 'codex',
      label: 'Codex CLI',
      account_id: null,
      account_label: null,
      state: 'ok',
      reason: null,
      windows: [
        { name: '5-hour', used_percent: 87, minutes: 300, resets_at_ms: NOW + 10 * H, reset_since: false },
        { name: 'Weekly', used_percent: 31, minutes: 10080, resets_at_ms: NOW + 4 * 24 * H, reset_since: false },
      ],
      plan: 'plus',
      observed_at_ms: NOW - 60_000,
      limited_until_ms: null,
      page: 'https://example.test/codex-usage',
    },
    {
      agent_id: 'cursor_agent',
      label: 'Cursor Agent CLI',
      account_id: null,
      account_label: null,
      state: 'expired',
      reason: 'The sign-in has expired.',
      windows: [],
      plan: null,
      observed_at_ms: null,
      limited_until_ms: null,
      page: null,
    },
  ],
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useChinese();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  useEnglish();
  act(() => root.unmount());
  host.remove();
  invoke.mockReset();
});

async function render() {
  invoke.mockImplementation(async (cmd: string) => (cmd === 'usage_snapshot' ? SNAP : null));
  await act(async () => root.render(<div className="cockpit"><UsageBar working={1} needsYou={2} /></div>));
  await act(async () => {});
  await act(async () => {});
}

describe('the Used bar in Traditional Chinese', () => {
  it('its caption, counts, refresh button and labels are in Chinese', async () => {
    await render();
    const strip = host.querySelector<HTMLElement>('.ck-statusbar')!;
    expect(strip.getAttribute('aria-label')).toBe(t('status.planUsage'));
    expect(strip.querySelector('.ck-usage-cap')!.textContent).toBe(t('status.usage'));
    expect(strip.querySelector('.ck-sb-counts')!.textContent).toBe(t('status.working', { n: 1 }) + t('status.needsYou', { count: 2 }));
    expect(strip.querySelector('.ck-usage-refresh')!.getAttribute('aria-label')).toBe(t('status.refreshUsage'));
    expect(visibleEnglish(strip.querySelector('.ck-usage-cap')!)).toEqual([]);
    expect(visibleEnglish(strip.querySelector('.ck-sb-counts')!)).toEqual([]);
  });

  it('the popover has its title, the usage page link, the percent used and the meter names in Chinese', async () => {
    await render();
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.ck-usage-chip')!.click();
    });
    await act(async () => {});
    const pop = document.querySelector<HTMLElement>('.ck-usage-pop')!;
    expect(pop).not.toBeNull();
    expect(pop.getAttribute('aria-label')).toBe(t('status.usage'));
    expect(pop.querySelector('.ck-usage-pop-title')!.textContent).toBe(t('status.usage'));
    expect(pop.querySelector('.ck-usage-link')!.textContent).toBe(t('status.usagePage'));
    expect(pop.querySelector('[role="meter"]')!.getAttribute('aria-label')).toBe(t('status.windowUsed', { name: '5-hour' }));
    expect([...pop.querySelectorAll('.ck-usage-win-pct')].map((n) => n.textContent)).toContain(t('status.percentUsed', { pct: 87 }));
    expect(visibleEnglish(pop.querySelector('.ck-usage-pop-top')!)).toEqual([]);
  });
});
