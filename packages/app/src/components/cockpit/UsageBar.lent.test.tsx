// @vitest-environment jsdom
// While this PC's own (main) sign-in is lent out, its chip says how many requests the borrowers made ("lent: N requests"): the plan numbers
// are read from the provider and lag, so the chip alone looked unused. Nothing is added for a lend of another sign-in, or when nothing is lent.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRANT_OUT, lendState } from '../../dev/lend-fixtures';
import type { Grant, LendProfile } from '../../lib/lend';
import type { UsageApi, UsageRow } from '../../lib/usage';

vi.mock('../../lib/settings', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/settings')>();
  return { ...real, loadSettings: async () => ({ ...(await real.loadSettings()), show_usage_bar: true }) };
});
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
let grants: Grant[] = [];
let profiles: LendProfile[] = [];
vi.mock('../lend/useLend', () => ({
  useLend: () => ({ state: lendState({ grants, profiles }), enabled: true, known: true, now: Date.now(), refresh: () => undefined }),
}));

import { UsageBar } from './UsageBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const NOW = Date.now();
const row: UsageRow = {
  agent_id: 'claude', label: 'Claude', account_id: null, account_label: null, state: 'ok', reason: null,
  windows: [{ name: '5-hour', used_percent: 83, minutes: 300, resets_at_ms: NOW + 3_600_000, reset_since: false }],
  plan: null, observed_at_ms: NOW, limited_until_ms: null, page: null,
} as UsageRow;
let shownRows: UsageRow[] = [row];
const api: UsageApi = { snapshot: async () => ({ rows: shownRows, refreshed_at_ms: NOW }), openPage: async () => {}, onChanged: async () => () => {} };
const profile = (id: string, kind: 'main' | 'account'): LendProfile => ({ id, name: id, agent_ids: ['claude'], account: kind === 'main' ? { kind: 'main' } : { kind: 'account', id: 'a1' }, who: 'my_pcs', member_ids: [], default_secs: 3600, max_secs: 3600, approval: 'none', sign_out_on_end: false, keep_awake: false });
const lent = (profile_id: string, over: Partial<Grant> = {}): Grant => ({ ...GRANT_OUT, agent_id: 'claude', profile_id, requests: 7, ends_ms: NOW + 3_600_000, ...over });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
  window.localStorage.clear();
  shownRows = [row];
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function show() {
  await act(async () => root.render(<UsageBar api={api} />));
  for (let i = 0; i < 8; i++) await act(async () => {});
  return host.querySelector('[data-testid="usage-lent"]')?.textContent ?? null;
}

describe('the usage chip of a lent sign-in', () => {
  it('says how many requests were made on it while it is lent', async () => {
    profiles = [profile('p-main', 'main')];
    grants = [lent('p-main')];
    expect(await show()).toBe('lent: 7 requests');
  });
  it('says nothing when nothing of the main sign-in is lent', async () => {
    profiles = [profile('p-main', 'main'), profile('p-acc', 'account')];
    for (const list of [[], [lent('p-main', { state: 'ended' })], [lent('p-main', { agent_id: 'codex' })]]) {
      grants = list;
      expect(await show()).toBeNull();
    }
  });
  it('a lend sign-in own chip (named by its profile) says it too, when that sign-in is the one lent', async () => {
    profiles = [profile('p-acc', 'account')];
    shownRows = [{ ...row, account_id: 'a1', account_label: "ren's claude", link: 'lend' } as UsageRow];
    grants = [lent('p-acc')];
    expect(await show()).toBe('lent: 7 requests');
    grants = [];
    expect(await show()).toBeNull();
  });
  it('a lend whose account has no chip of its own counts on the agent first chip, and the tooltip names the lend', async () => {
    profiles = [profile('p-acc', 'account')];
    grants = [lent('p-acc', { profile_name: "ren's claude" })];
    expect(await show()).toBe('lent: 7 requests');
    expect(host.querySelector('.ck-usage-chip')?.getAttribute('title')).toContain("ren's claude · lent: 7 requests");
  });
  it('a lend of another account that has its own chip is not counted on the main chip', async () => {
    profiles = [profile('p-acc', 'account')];
    shownRows = [row, { ...row, account_id: 'a1', account_label: "ren's claude", link: 'lend' } as UsageRow];
    grants = [lent('p-acc')];
    await show();
    const lents = [...host.querySelectorAll('.ck-usage-chip')].map((c) => c.querySelector('[data-testid="usage-lent"]')?.textContent ?? null);
    expect(lents.slice(0, 2)).toEqual([null, 'lent: 7 requests']);
  });
});
