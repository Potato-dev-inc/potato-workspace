// @vitest-environment jsdom
// Screen level: the "Used" bar renders along the bottom of the cockpit (a child of the cockpit root, not in the
// real sidebar, whose footer no longer has it), from the desktop's `usage_snapshot`. A chip warns at 80 %; chips
// that do not fit become "+N"; clicking opens the Usage popover above the bar (tightest limit first, a bar per
// window, the usage page, refresh). Hidden, taking no space, when off or when nothing is signed in. SYNTHETIC rows.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ShipApi } from '../../lib/ship-api';
import type { UsageSnapshot } from '../../lib/usage';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

// The "Show usage bar" setting, as the settings store would report it.
const usageBar = { on: true };
vi.mock('../../lib/settings', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/settings')>();
  return { ...real, loadSettings: async () => ({ ...(await real.loadSettings()), show_usage_bar: usageBar.on }) };
});

import { Sidebar } from './Sidebar';
import { UsageBar, fitCount, popoverPlace } from './UsageBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

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
      agent_id: 'codex',
      label: 'Codex CLI',
      account_id: 'acc_1',
      account_label: 'Work',
      state: 'limited',
      reason: null,
      windows: [{ name: 'Monthly', used_percent: 100, minutes: 43200, resets_at_ms: NOW + 3 * H, reset_since: false }],
      plan: 'free',
      observed_at_ms: NOW - 60_000,
      limited_until_ms: NOW + 3 * H,
      page: 'https://example.test/codex-usage',
    },
    {
      agent_id: 'claude',
      label: 'Claude',
      account_id: null,
      account_label: null,
      state: 'unknown',
      reason: 'Type /usage in a Claude pane, or open the usage page.',
      windows: [],
      plan: null,
      observed_at_ms: null,
      limited_until_ms: null,
      page: 'https://example.test/claude-usage',
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
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  invoke.mockReset();
  usageBar.on = true;
});

function fakeApi(): CockpitApi {
  const info = { id: 'p1', agent_type: 'codex', pid: 1, status: 'idle', created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 80, rows: 24, title: null } as unknown as PaneInfo;
  const panes = [{ info, status: 'idle' }];
  return {
    registry: { paneList: panes, panes: new Map([['p1', panes[0]]]), initialReady: true },
    names: new Map([['p1', 'Codex']]),
    asked: { questions: [] },
    launchEntries: [{ type: 'codex', label: 'Codex' }],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: 'p1',
    select: vi.fn(),
    prompts: {},
    statusSince: new Map([['p1', 0]]),
    now: 60_000,
    spawn: null,
    toasts: [],
    notify: vi.fn(),
    openSettings: vi.fn(async () => {}),
    bridgeLine: '',
  } as unknown as CockpitApi;
}

const ship = { recent: vi.fn().mockResolvedValue([]), gitState: vi.fn().mockResolvedValue('repo') } as unknown as ShipApi;

async function render(snap: UsageSnapshot) {
  invoke.mockImplementation(async (cmd: string) => (cmd === 'usage_snapshot' ? snap : null));
  // The cockpit's own shape: the root with the sidebar, the main area and the bar (CockpitApp.tsx).
  await act(async () =>
    root.render(
      <div className="cockpit">
        <Sidebar c={fakeApi()} onOpenPalette={() => {}} ship={ship} />
        <main className="ck-main" />
        <UsageBar />
      </div>,
    ),
  );
  await act(async () => {});
  await act(async () => {});
}

const chipsIn = (el: ParentNode) => [...el.querySelectorAll<HTMLButtonElement>('.ck-sb-chips .ck-usage-chip')];

describe('the Used bar at the bottom of the cockpit', () => {
  it('is a child of the cockpit root, not in the sidebar, with one chip per sign-in', async () => {
    await render(SNAP);
    const strip = host.querySelector<HTMLElement>('.cockpit > .ck-statusbar[role="group"][aria-label="Plan usage"]');
    expect(strip).not.toBeNull();
    expect(strip!.closest('.ck-side')).toBeNull();
    expect(host.querySelector('.ck-side-foot .ck-usage, .ck-side-foot .ck-statusbar, .ck-side-foot .ck-usage-chip')).toBeNull();
    // The root leaves room for it through CSS (`.cockpit:has(> .ck-statusbar)`, cockpit-statusbar.css).
    expect(strip!.querySelector('.ck-usage-cap')?.textContent).toBe('Used');
    const chips = chipsIn(strip!);
    expect(chips.map((c) => c.querySelector('.ck-usage-text')?.textContent)).toEqual([
      '⚠ 87% 10h',
      '⚠ Limited · 3h',
      'Not shared',
      '⚠ Sign-in expired',
    ]);
    // Codex, Claude and Cursor have a logo, so none of them gets a letter badge.
    expect(chips.map((c) => c.querySelector('.ck-usage-ic')?.textContent)).toEqual(['', '', '', '']);
    expect(chips.map((c) => c.querySelector('[data-mark="logo"]')?.getAttribute('data-logo'))).toEqual(['OpenAI', 'OpenAI', 'Claude', 'Cursor']);
    // Numbers only: no names in the bar. The two Codex sign-ins are told apart by a tiny tag of the account label;
    // the agent with one sign-in gets none.
    expect(chips.map((c) => c.querySelector('.ck-usage-suffix')?.textContent ?? null)).toEqual([null, 'Work', null, null]);
    expect(strip!.textContent).not.toContain('Codex CLI');
    expect(strip!.textContent).not.toContain('Cursor Agent CLI');
    expect(chips.some((c) => c.querySelector('[data-mark="letters"]'))).toBe(false);
    // The tooltip carries the windows, the plan, the sign-in and the reason.
    expect(chips[0].title).toContain('Weekly: 31% used');
    expect(chips[0].title).toContain('Plan: plus');
    expect(chips[1].title).toContain('Sign-in: Work');
    expect(chips[2].title).toContain('/usage');
    // No text a person reads names the product "Claude Code".
    expect(strip!.textContent).not.toContain('Claude Code');
  });

  it('places the popover above the strip, inside the window, at most 360px wide', () => {
    expect(popoverPlace({ left: 12, top: 700 }, 1440, 900)).toEqual({ left: 12, bottom: 206, width: 360 });
    // Near the right edge it moves left; in a narrow window it narrows and never scrolls sideways.
    expect(popoverPlace({ left: 1300, top: 700 }, 1440, 900).left).toBe(1440 - 360 - 8);
    const narrow = popoverPlace({ left: 0, top: 500 }, 300, 600);
    expect(narrow.left + narrow.width).toBeLessThanOrEqual(300);
  });

  it('a sign-in label is a short tag in the chip (never a clipped word) and whole in its tooltip and the popover', async () => {
    const lend = { ...SNAP.rows[1], account_label: 'Lend Claude for the whole team' };
    await render({ ...SNAP, rows: [SNAP.rows[0], lend] });
    const chip = chipsIn(host)[1];
    expect(chip.querySelector('.ck-usage-suffix')?.textContent).toBe('Lend Claude…');
    expect(chip.title).toContain('Sign-in: Lend Claude for the whole team');
    await act(async () => chip.click());
    const names = [...document.querySelectorAll('.ck-usage-pop-name')].map((n) => n.textContent);
    expect(names).toContain('Codex CLI (Lend Claude for the whole team)');
    expect(document.querySelectorAll('.ck-usage-pop-head [data-mark]').length).toBe(2);
  });

  it('an unknown agent gets a letter mark from its id', async () => {
    const odd = { ...SNAP.rows[2], agent_id: 'kilo', label: 'Kilo' };
    await render({ ...SNAP, rows: [odd] });
    expect(chipsIn(host)[0].querySelector('[data-mark="letters"]')?.textContent).toBe('KI');
  });

  it('warns at 80 % and not below', async () => {
    const low = { ...SNAP.rows[0], windows: [{ ...SNAP.rows[0].windows[0], used_percent: 79 }] };
    await render({ ...SNAP, rows: [low] });
    const chip = chipsIn(host)[0];
    expect(chip.classList.contains('is-warn')).toBe(false);
    expect(chip.querySelector('.ck-usage-text')?.textContent).toBe('79% 10h');
  });

  it('a chip opens the Usage popover above the bar: tightest first, bars, the usage page, refresh', async () => {
    await render(SNAP);
    const bar = host.querySelector<HTMLElement>('.ck-statusbar')!;
    // The bar is the bottom 26px of the window.
    bar.getBoundingClientRect = () => ({ top: window.innerHeight - 26, left: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: 26, x: 0, y: window.innerHeight - 26, toJSON: () => ({}) });
    const chips = chipsIn(host);
    chips[2].focus();
    expect(document.activeElement).toBe(chips[2]);
    await act(async () => chips[2].click());
    const pop = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Usage"]');
    expect(pop).not.toBeNull();
    // A fixed layer outside the sidebar (whose scrolling box would clip it), with a width and a place on screen.
    expect(pop!.closest('.ck-side')).toBeNull();
    expect(pop!.closest('.ck-side-foot')).toBeNull();
    expect(host.querySelector('.ck-side')?.contains(pop)).toBe(false);
    expect(pop!.style.width).toMatch(/px$/);
    expect(pop!.style.left).toMatch(/px$/);
    // Above the bar: its bottom edge is 6px over the bar's top.
    expect(pop!.style.bottom).toBe(`${26 + 6}px`);
    expect(bar.contains(pop)).toBe(false);
    const names = [...pop!.querySelectorAll('.ck-usage-pop-name')].map((n) => n.textContent);
    expect(names).toEqual(['Codex CLI (Work)', 'Cursor Agent CLI', 'Codex CLI', 'Claude']);
    const meters = [...pop!.querySelectorAll('[role="meter"]')].map((m) => `${m.getAttribute('aria-label')} ${m.getAttribute('aria-valuenow')}`);
    expect(meters).toEqual(['Monthly used 100', '5-hour used 87', 'Weekly used 31']);
    expect(pop!.textContent).toContain('87% used');
    expect(pop!.textContent).toContain('Resets in 10h');
    const page = [...pop!.querySelectorAll<HTMLButtonElement>('.ck-usage-link')][0];
    await act(async () => page.click());
    expect(invoke).toHaveBeenCalledWith('open_external_url', { url: 'https://example.test/codex-usage' });
    const refresh = pop!.querySelector<HTMLButtonElement>('button[aria-label="Refresh usage"]')!;
    await act(async () => refresh.click());
    expect(invoke).toHaveBeenCalledWith('usage_snapshot', { refresh: true, loginReads: true });
    // Escape closes it.
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(document.querySelector('[role="dialog"][aria-label="Usage"]')).toBeNull();
  });

  it('is hidden, and asks nothing, while Settings turns the usage bar off', async () => {
    usageBar.on = false;
    await render(SNAP);
    expect(host.querySelector('.ck-statusbar')).toBeNull();
    expect(invoke.mock.calls.some(([cmd]) => cmd === 'usage_snapshot')).toBe(false);
  });

  it('chips that do not fit collapse into "+N", which opens the popover', async () => {
    // jsdom has no layout: give the chip row 300px and each chip 120px.
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    const client = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return (this as HTMLElement).classList.contains('ck-usage-chip') ? 120 : 0; } });
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get() { return (this as Element).classList.contains('ck-sb-chips') ? 300 : 0; } });
    try {
      await render(SNAP);
      await act(async () => {});
      expect(chipsIn(host)).toHaveLength(2);
      const more = host.querySelector<HTMLButtonElement>('.ck-sb-more')!;
      expect(more.textContent).toBe('+2');
      expect(more.title).toContain('Claude');
      await act(async () => more.click());
      expect(document.querySelector('[role="dialog"][aria-label="Usage"]')).not.toBeNull();
    } finally {
      if (width) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width);
      if (client) Object.defineProperty(Element.prototype, 'clientWidth', client);
    }
  });

  it('fits as many chips as the line holds, keeping room for "+N"', () => {
    expect(fitCount([100, 100, 100], 400, 10, 34)).toBe(3);
    expect(fitCount([100, 100, 100], 300, 10, 34)).toBe(2);
    expect(fitCount([100, 100, 100], 150, 10, 34)).toBe(1);
    expect(fitCount([100, 100, 100], 50, 10, 34)).toBe(0);
  });

  it('shows nothing when no agent is signed in', async () => {
    await render({ rows: [], refreshed_at_ms: NOW });
    expect(host.querySelector('.ck-statusbar')).toBeNull();
    expect(host.querySelector('.ck-side-foot')).not.toBeNull();
  });
});
