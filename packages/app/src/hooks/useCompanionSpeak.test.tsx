// @vitest-environment jsdom
// The usage nudge speaks once per threshold per reset window, and the memory survives a reload.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CompanionView } from '../lib/companion';
import { SPEAK_DEFAULTS, SPEAK_MEMORY_KEY, USAGE_LATER_MS, type SpeakSettings } from '../lib/companionSpeak';
import type { UsageRow } from '../lib/usage';
import { SPEAK_TICK_MS, useCompanionSpeak, type CompanionSpeak } from './useCompanionSpeak';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settings: SpeakSettings = { ...SPEAK_DEFAULTS, on: true, perHour: 12 };
const companion = { state: 'awake' } as unknown as CompanionView;
const T0 = new Date(2026, 10, 15, 14, 0, 0).getTime();
const HOUR = 3_600_000;

const row = (percent: number, resetsAt = T0 + 3 * HOUR): UsageRow => ({
  agent_id: 'claude', label: 'Claude', account_id: null, account_label: null, state: 'ok', reason: null,
  windows: [{ name: '5-hour', used_percent: percent, resets_at_ms: resetsAt, reset_since: false }],
  plan: null, observed_at_ms: T0, limited_until_ms: null, page: null,
});

let host: HTMLDivElement;
let root: Root;
let clockNow = T0;
let last: CompanionSpeak;
beforeEach(() => {
  localStorage.clear();
  clockNow = T0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function Probe({ rows }: { rows: UsageRow[] }) {
  last = useCompanionSpeak({ settings, companion, needsYou: [], panes: [], nameOf: (id) => id, usageRows: rows, now: () => clockNow });
  return null;
}
const mount = (rows: UsageRow[]) => act(() => root.render(<Probe rows={rows} />));
/** A new hook instance, as after a reload: same storage, nothing in memory. */
const reload = (rows: UsageRow[]) => {
  act(() => root.unmount());
  root = createRoot(host);
  mount(rows);
};

describe('usage nudge', () => {
  it('shows 92% once, and a reload shows nothing', () => {
    mount([row(92)]);
    expect(last.event?.kind).toBe('usage');
    expect(last.event?.threshold).toBe(80);
    act(() => last.open());
    reload([row(92)]);
    expect(last.event).toBeNull();
  });

  it('speaks again at the next threshold, and again in a new reset window', () => {
    mount([row(92)]);
    act(() => last.open());
    clockNow += 10 * 60_000;
    mount([row(96)]);
    expect(last.event?.threshold).toBe(95);
    act(() => last.open());
    clockNow += 10 * 60_000;
    reload([row(96, T0 + 9 * HOUR)]);
    expect(last.event?.threshold).toBe(95);
  });

  it('Later keeps the kind quiet for an hour, even at the next threshold, and never repeats the same one', () => {
    mount([row(85)]);
    act(() => last.later());
    clockNow += 10 * 60_000;
    reload([row(96)]);
    expect(last.event).toBeNull();
    clockNow += USAGE_LATER_MS;
    mount([row(96)]);
    expect(last.event?.threshold).toBe(95);
    act(() => last.later());
    clockNow += 2 * USAGE_LATER_MS + SPEAK_TICK_MS;
    reload([row(96)]);
    expect(last.event).toBeNull();
  });

  it('Too much silences usage for good (also after a reload)', () => {
    mount([row(85)]);
    act(() => last.tooMuch());
    clockNow += 3 * HOUR;
    reload([row(97, T0 + 9 * HOUR)]);
    expect(last.event).toBeNull();
    expect(localStorage.getItem(SPEAK_MEMORY_KEY)).toContain('usage');
  });
});
