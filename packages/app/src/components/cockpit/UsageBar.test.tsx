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
import { notePace, resetPaceHistory, type UsageSnapshot } from '../../lib/usage';

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
    expect(strip!.querySelector('.ck-usage-cap')?.textContent).toBe('Usage');
    const chips = chipsIn(strip!);
    expect(chips.map((c) => c.querySelector('.ck-usage-text')?.textContent)).toEqual([
      '⚠ 87%',
      '⚠ Limit reached · resets in 3 hours',
      'Usage not shared',
      'Sign-in expired',
    ]);
    // Codex, Claude and Cursor have a logo, so none of them gets a letter badge.
    expect(chips.map((c) => c.querySelector('.ck-usage-ic')?.textContent)).toEqual(['', '', '', '']);
    expect(chips.map((c) => c.querySelector('[data-mark="logo"]')?.getAttribute('data-logo'))).toEqual(['OpenAI', 'OpenAI', 'Claude', 'Cursor']);
    // Numbers only: no names in the bar. The two Codex sign-ins are told apart by a tiny tag of the account label;
    // the agent with one sign-in gets none.
    expect(chips.map((c) => c.querySelector('.ck-usage-suffix')?.textContent ?? null)).toEqual([null, 'Work', null, null]);
    expect(strip!.textContent).not.toContain('Codex CLI');
    expect(strip!.textContent).not.toContain('Cursor Agent CLI');
    expect(chips.some((c) => c.querySelector('[data-mark="monogram"]'))).toBe(false);
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

  it('an agent without a published logo gets a monogram of its name', async () => {
    const odd = { ...SNAP.rows[2], agent_id: 'kilo', label: 'Kilo' };
    await render({ ...SNAP, rows: [odd] });
    expect(chipsIn(host)[0].querySelector('[data-mark="monogram"]')?.getAttribute('data-letter')).toBe('K');
  });

  it('warns at 80 % and not below', async () => {
    const low = { ...SNAP.rows[0], windows: [{ ...SNAP.rows[0].windows[0], used_percent: 79 }] };
    await render({ ...SNAP, rows: [low] });
    const chip = chipsIn(host)[0];
    expect(chip.classList.contains('is-warn')).toBe(false);
    expect(chip.querySelector('.ck-usage-text')?.textContent).toBe('79%');
    expect(chip.querySelector('.ck-usage-reset')?.textContent).toBe('10h');
    expect(chip.classList.contains('tone-calm')).toBe(true);
    expect(chip.title.split('\n')[0]).toBe('Codex CLI: 79% used, resets in 10 hours');
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
    expect(pop!.textContent).toContain('Resets in 10 hours');
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

describe('a pay-per-use agent (OpenCode) in the Used bar', () => {
  const OPENCODE: UsageSnapshot = {
    refreshed_at_ms: NOW,
    rows: [
      {
        agent_id: 'opencode',
        label: 'OpenCode',
        account_id: null,
        account_label: null,
        state: 'ok',
        reason: null,
        windows: [],
        totals: {
          today: { cost: 1.236, tokens: 310_400 },
          week: { cost: 9.5, tokens: 2_400_000 },
          models: [
            { model: 'model-a', cost: 7, tokens: 1_900_000 },
            { model: 'model-b', cost: 2.5, tokens: 500_000 },
          ],
        },
        plan: null,
        observed_at_ms: NOW - 60_000,
        limited_until_ms: null,
        page: null,
      },
    ],
  };

  it('shows what it spent today, with no limit, and lists each model in the popover', async () => {
    await render(OPENCODE);
    const chip = chipsIn(host)[0];
    expect(chip.querySelector('.ck-usage-text')?.textContent).toBe('$1.24 today · 310k tokens');
    expect(chip.classList.contains('is-warn')).toBe(false);
    expect(chip.title).toContain('Last 7 days: $9.50, 2.4M tokens');
    expect(chip.title).not.toContain('% used');
    await act(async () => chip.click());
    const totals = document.querySelector('[data-testid="usage-totals"]')!;
    expect(totals.textContent).toContain('Today$1.24 · 310k tokens');
    expect(totals.textContent).toContain('model-a$7.00 · 1.9M tokens');
    expect(totals.textContent).toContain('model-b$2.50 · 500k tokens');
    expect(document.querySelectorAll('[role="meter"]').length).toBe(0);
  });

  it('shows the week when nothing was spent today, and "Usage not shared" without numbers', async () => {
    const quiet = { ...OPENCODE.rows[0], totals: { ...OPENCODE.rows[0].totals!, today: { cost: 0, tokens: 0 } } };
    await render({ ...OPENCODE, rows: [quiet] });
    expect(chipsIn(host)[0].querySelector('.ck-usage-text')?.textContent).toBe('$9.50 this week · 2.4M tokens');
    act(() => root.unmount());
    root = createRoot(host);
    await render({ ...OPENCODE, rows: [{ ...OPENCODE.rows[0], state: 'unknown', totals: undefined, reason: 'No OpenCode usage found yet.' }] });
    expect(chipsIn(host)[0].querySelector('.ck-usage-text')?.textContent).toBe('Usage not shared');
  });
});

describe('status bar groups and the right-hand counts (proposal 20)', () => {
  it('each group is icon, percent, a tiny bar and the reset time; risk from 80 %, danger when expired', async () => {
    await render(SNAP);
    const [codex, , , expired] = chipsIn(host);
    expect(codex.classList.contains('tone-risk')).toBe(true);
    expect(codex.querySelector('.ck-usage-pct')?.textContent).toBe('⚠ 87%');
    expect((codex.querySelector('.ck-usage-meter > span') as HTMLElement).style.width).toBe('87%');
    expect(codex.querySelector('.ck-usage-reset')?.textContent).toBe('10h');
    expect(expired.classList.contains('tone-danger')).toBe(true);
    expect(expired.tagName).toBe('BUTTON');
  });

  it('shows "N working" and "N need you" on the right, and nothing when both are zero', async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === 'usage_snapshot' ? SNAP : null));
    await act(async () => root.render(<div className="cockpit"><UsageBar working={2} needsYou={1} /></div>));
    await act(async () => {});
    await act(async () => {});
    const counts = host.querySelector('.ck-sb-counts')!;
    expect(counts.querySelector('.is-working')?.textContent).toBe('2 working');
    expect(counts.querySelector('.is-working .ck-sb-live')).not.toBeNull();
    expect(counts.querySelector('.is-needs')?.textContent).toBe('1 needs you');
    await act(async () => root.render(<div className="cockpit"><UsageBar /></div>));
    await act(async () => {});
    expect(host.querySelector('.ck-sb-count')).toBeNull();
  });

  it('OpenCode keeps showing spend, not a percent or a bar', async () => {
    const oc = { ...SNAP.rows[0], agent_id: 'opencode', label: 'OpenCode', windows: [], totals: { today: { cost: 1.24, tokens: 310000 }, week: { cost: 9, tokens: 2400000 }, models: [] } };
    await render({ ...SNAP, rows: [oc] });
    const chip = chipsIn(host)[0];
    expect(chip.querySelector('.ck-usage-meter')).toBeNull();
    expect(chip.querySelector('.ck-usage-text')?.textContent).toBe('$1.24 today · 310k tokens');
  });
});

describe('the three chip shapes (proposal 8)', () => {
  it('the shared chip stylesheet defines Count, Label and Key at 18px, radius 5', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/styles/chips.css', 'utf8');
    for (const k of ['ck-chip-count', 'ck-chip-label', 'ck-chip-key']) expect(css).toContain(`.cockpit .${k}`);
    expect(css).toMatch(/height:\s*18px/);
    expect(css).toMatch(/border-radius:\s*5px/);
    expect(css).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});

describe('the usage forecast in the Usage popover (proposal 27)', () => {
  const row = (pct: number, now: number) => ({
    ...SNAP.rows[0],
    windows: [{ name: '5-hour', used_percent: pct, minutes: 300, resets_at_ms: now + 3 * H, reset_since: false }],
  });

  it('one line per agent with a limit, saying "about" when the limit comes before the reset', async () => {
    resetPaceHistory();
    const now = Date.now();
    // 30 % twenty minutes ago and 50 % now: a pace of 1 % a minute, so the limit is about 50 minutes away.
    notePace(row(30, now), now - 20 * 60_000);
    await render({ refreshed_at_ms: now, rows: [row(50, now)] });
    await act(async () => chipsIn(host)[0].click());
    const line = document.querySelector('[data-testid="usage-forecast"]');
    expect(line?.textContent).toContain('about');
    expect(line?.textContent).toContain('resets');
  });

  it('shows no line without data for a pace', async () => {
    resetPaceHistory();
    const now = Date.now();
    await render({ refreshed_at_ms: now, rows: [row(50, now)] });
    await act(async () => chipsIn(host)[0].click());
    expect(document.querySelector('[data-testid="usage-forecast"]')).toBeNull();
  });
});
