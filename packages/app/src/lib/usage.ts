// The "Used" bar (components/cockpit/UsageBar.tsx, along the bottom of the cockpit): how much of its plan each signed-in agent has used.
// The desktop command is `usage_snapshot` (Rust `usage/`); `usage://changed` arrives when the background
// refresh (every few minutes, once the strip asked) finds different numbers. Numbers, times and plan names only.
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getLanguage, t } from '../i18n';
import { loadSettings } from './settings';

/** The event the desktop sends (`usage::EVENT`). */
export const USAGE_EVENT = 'usage://changed';

export interface UsageWindow {
  /** "5-hour", "Weekly", "Monthly"... */
  name: string;
  used_percent: number;
  minutes?: number;
  resets_at_ms?: number;
  /** The reset time passed since the agent last reported: the window started again. */
  reset_since: boolean;
}

/** What a pay-per-use agent spent (no plan, so no limit window). */
export interface UsageSpend {
  cost: number;
  tokens: number;
}

export interface UsageTotals {
  today: UsageSpend;
  week: UsageSpend;
  /** Last 7 days, biggest cost first. */
  models: { model: string; cost: number; tokens: number }[];
}

export type UsageState = 'ok' | 'limited' | 'expired' | 'unknown';

export interface UsageRow {
  agent_id: string;
  label: string;
  account_id: string | null;
  account_label: string | null;
  state: UsageState;
  reason: string | null;
  windows: UsageWindow[];
  /** Pay-per-use agents only. */
  totals?: UsageTotals;
  plan: string | null;
  observed_at_ms: number | null;
  limited_until_ms: number | null;
  page: string | null;
}

export interface UsageSnapshot {
  rows: UsageRow[];
  refreshed_at_ms: number;
}

/** Injectable for tests and the harness. */
export interface UsageApi {
  snapshot: (refresh: boolean, loginReads: boolean) => Promise<UsageSnapshot>;
  openPage: (url: string) => Promise<void>;
  onChanged: (fn: (snap: UsageSnapshot) => void) => Promise<UnlistenFn>;
}

export const usageApi: UsageApi = {
  snapshot: (refresh, loginReads) => invoke<UsageSnapshot>('usage_snapshot', { refresh, loginReads }),
  openPage: (url) => invoke<void>('open_external_url', { url }),
  onChanged: (fn) => listen<UsageSnapshot>(USAGE_EVENT, (e) => fn(e.payload)),
};

/** "9h 55m", "12d 1h", "45m", "now". */
export function formatLeft(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return t('state.usage.now');
  const mins = Math.max(1, Math.round(ms / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** The same wait in words, one unit: "12 days", "9 hours", "40 min". Under a minute: "a moment". */
export function formatLeftLong(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return t('state.usage.moment');
  const mins = Math.max(1, Math.round(ms / 60_000));
  const days = Math.floor(mins / 1440);
  if (days >= 1) return t('state.usage.days', { count: days });
  const hours = Math.floor(mins / 60);
  if (hours >= 1) return t('state.usage.hours', { count: hours });
  return t('state.usage.min', { count: mins });
}

/** The window the chip shows: the fullest one. */
export function headline(row: UsageRow): UsageWindow | null {
  if (row.windows.length === 0) return null;
  return row.windows.reduce((best, w) => (w.used_percent > best.used_percent ? w : best));
}

/** Percent used from which a chip warns (like Orca). */
export const NEAR_LIMIT = 80;

/** The chip warns: limited, sign-in expired, or a window at 80 % or more. */
export function warns(row: UsageRow): boolean {
  if (row.state === 'limited' || row.state === 'expired') return true;
  const top = headline(row);
  return row.state === 'ok' && !!top && !top.reset_since && top.used_percent >= NEAR_LIMIT;
}

/** How tight a sign-in is, for the popover's order: limited and expired first, then the fullest window. */
function tightness(row: UsageRow): number {
  if (row.state === 'limited') return 1000;
  if (row.state === 'expired') return 900;
  if (row.state === 'unknown') return -1;
  if (row.totals && !row.windows.length) return 0;
  return headline(row)?.used_percent ?? -1;
}

/** Every sign-in, tightest limit first. */
export function tightestFirst(rows: UsageRow[]): UsageRow[] {
  return [...rows].sort((a, b) => tightness(b) - tightness(a));
}

/** "$1.24", "<$0.01", "$0.00". */
export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '$0.00';
  return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`;
}

/** "950", "310k", "1.2M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "$1.24 today · 310k tokens", or this week's when nothing was spent today. Never a limit. */
export function totalsText(totals: UsageTotals): string {
  const quiet = totals.today.cost <= 0 && totals.today.tokens <= 0;
  const span = quiet ? totals.week : totals.today;
  return t(quiet ? 'state.usage.totalsWeek' : 'state.usage.totalsToday', { cost: formatCost(span.cost), tokens: formatTokens(span.tokens) });
}

/** The words after the icon. */
export function chipText(row: UsageRow, now: number): string {
  if (row.state === 'expired') return t('state.usage.signInExpired');
  if (row.state === 'limited') {
    return row.limited_until_ms && row.limited_until_ms > now ? t('state.usage.limitResets', { time: formatLeftLong(row.limited_until_ms - now) }) : t('state.usage.limitReached');
  }
  const top = headline(row);
  if (row.state === 'ok' && row.totals && !top) return totalsText(row.totals);
  if (row.state === 'unknown' || !top) return t('state.usage.notShared');
  const pct = Math.round(top.used_percent);
  return top.resets_at_ms && top.resets_at_ms > now ? t('state.usage.pctUsedResets', { pct, time: formatLeftLong(top.resets_at_ms - now) }) : t('state.usage.pctUsed', { pct });
}

/** What a status-bar group shows: icon, percent, a tiny bar, the time to reset. Null `pct` = a word instead (see `chipText`). */
export interface GroupParts {
  pct: number | null;
  /** "5d 18h" (short), empty when the agent gave no reset time. */
  reset: string;
  tone: 'calm' | 'risk' | 'danger';
}

export function groupParts(row: UsageRow, now: number): GroupParts {
  if (row.state === 'expired') return { pct: null, reset: '', tone: 'danger' };
  const top = headline(row);
  const tone = warns(row) ? 'risk' : 'calm';
  if (row.state !== 'ok' || !top) return { pct: null, reset: '', tone };
  const reset = !top.reset_since && top.resets_at_ms && top.resets_at_ms > now ? formatLeft(top.resets_at_ms - now) : '';
  return { pct: Math.max(0, Math.min(100, Math.round(top.used_percent))), reset, tone };
}

/** The hover sentence: "Codex: 86% used, resets in 2 hours". Null when there is no single sentence to say. */
export function groupSentence(row: UsageRow, now: number): string | null {
  const g = groupParts(row, now);
  if (g.pct === null) return null;
  const top = headline(row) as UsageWindow;
  return top.resets_at_ms && top.resets_at_ms > now
    ? t('state.usage.sentenceResets', { name: rowName(row), pct: g.pct, time: formatLeftLong(top.resets_at_ms - now) })
    : t('state.usage.sentence', { name: rowName(row), pct: g.pct });
}

// ---- Usage forecast (proposal 27): "at this pace you hit the limit at about 15:40". A guess, always said as "about". ----

/** The pace is the change over this many minutes. */
export const PACE_SPAN_MS = 30 * 60_000;
/** Less data than this and there is no pace: show nothing. */
export const PACE_MIN_DATA_MS = 15 * 60_000;
/** A last sample older than this means no fresh numbers: show nothing. */
export const PACE_STALE_MS = 10 * 60_000;
/** Snapshots closer than this replace the last sample instead of adding one. */
const PACE_SAMPLE_GAP_MS = 60_000;

export interface PaceSample {
  at: number;
  pct: number;
}

/** Recent percent samples per limit window of each sign-in, in memory (the last 30 minutes). */
const paceHistory = new Map<string, PaceSample[]>();

function paceKeyOf(row: UsageRow, windowName: string): string {
  return `${row.agent_id}:${row.account_id ?? ''}:${windowName}`;
}

/** Forget every sample (tests, and a new session). */
export function resetPaceHistory(): void {
  paceHistory.clear();
}

/** Note the fullest window's percent at `now`. A drop in percent (a new window) or no numbers starts the history again. */
export function notePace(row: UsageRow, now: number): void {
  const top = row.state === 'ok' ? headline(row) : null;
  if (!top) return;
  const key = paceKeyOf(row, top.name);
  if (top.reset_since) {
    paceHistory.delete(key);
    return;
  }
  let samples = paceHistory.get(key) ?? [];
  if (samples.length && top.used_percent < samples[samples.length - 1].pct) samples = [];
  const last = samples[samples.length - 1];
  if (last && now - last.at < PACE_SAMPLE_GAP_MS) last.pct = top.used_percent;
  else samples.push({ at: now, pct: top.used_percent });
  paceHistory.set(
    key,
    samples.filter((s) => s.at >= now - PACE_SPAN_MS),
  );
}

/** Percent per minute over the last 30 minutes, or null with less than 15 minutes of fresh data. */
export function paceOf(samples: PaceSample[], now: number): number | null {
  const win = samples.filter((s) => s.at >= now - PACE_SPAN_MS && s.at <= now);
  if (win.length < 2) return null;
  const first = win[0];
  const last = win[win.length - 1];
  if (now - last.at > PACE_STALE_MS) return null;
  const span = last.at - first.at;
  if (span < PACE_MIN_DATA_MS) return null;
  return (last.pct - first.pct) / (span / 60_000);
}

export interface Forecast {
  /** When the limit comes at this pace. */
  hitAt: number;
  /** When the window resets. The limit must come before it to show. */
  resetsAt: number;
}

/** The forecast for the fullest window, or null: no pace, no reset time, a pace that falls, or a limit after the reset. */
export function forecastOf(row: UsageRow, now: number): Forecast | null {
  if (row.state !== 'ok') return null;
  const top = headline(row);
  if (!top || top.reset_since || !top.resets_at_ms || top.resets_at_ms <= now || top.used_percent >= 100) return null;
  const rate = paceOf(paceHistory.get(paceKeyOf(row, top.name)) ?? [], now);
  if (rate === null || rate <= 0) return null;
  const hitAt = now + ((100 - top.used_percent) / rate) * 60_000;
  if (hitAt >= top.resets_at_ms) return null;
  return { hitAt, resetsAt: top.resets_at_ms };
}

/** "15:40", or "Sat 15:40" when it is not today. */
function clockAt(ms: number, now: number): string {
  const lang = getLanguage() === 'zh-TW' ? 'zh-TW' : undefined;
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString();
  return new Date(ms).toLocaleString(lang, sameDay ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** "At this pace you hit the limit at about 15:40 · resets 17:00". */
export function forecastText(f: Forecast, now: number): string {
  return t('state.usage.forecast', { hit: clockAt(f.hitAt, now), reset: clockAt(f.resetsAt, now) });
}

/** Who the row is: "Codex CLI" or "Codex CLI (Work)". */
export function rowName(row: UsageRow): string {
  return row.account_label ? `${row.label} (${row.account_label})` : row.label;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleString(getLanguage() === 'zh-TW' ? 'zh-TW' : undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** The tooltip: sign-in, plan, each window with its reset, and why when there are no numbers. */
export function tooltip(row: UsageRow, now: number): string {
  const lines = [rowName(row), t('state.usage.signIn', { name: row.account_label ?? t('state.usage.mainLogin') })];
  if (row.plan) lines.push(t('state.usage.plan', { plan: row.plan }));
  for (const w of row.windows) {
    const reset = w.reset_since
      ? t('state.usage.startedAgain')
      : w.resets_at_ms
        ? t('state.usage.resetsAt', { time: formatLeftLong(w.resets_at_ms - now), at: clock(w.resets_at_ms) })
        : t('state.usage.resetUnknown');
    lines.push(t('state.usage.windowLine', { name: w.name, pct: Math.round(w.used_percent), reset }));
  }
  if (row.totals) {
    lines.push(t('state.usage.todayLine', { cost: formatCost(row.totals.today.cost), tokens: formatTokens(row.totals.today.tokens) }));
    lines.push(t('state.usage.weekLine', { cost: formatCost(row.totals.week.cost), tokens: formatTokens(row.totals.week.tokens) }));
  }
  if (row.state === 'limited') {
    lines.push(row.limited_until_ms && row.limited_until_ms > now ? t('state.usage.limitUntil', { at: clock(row.limited_until_ms) }) : t('state.usage.limitReached'));
  }
  if (row.reason) lines.push(row.reason);
  if (row.observed_at_ms) lines.push(t('state.usage.reported', { time: formatLeftLong(now - row.observed_at_ms) }));
  if (row.page) lines.push(t('state.usage.openPage'));
  return lines.join('\n');
}

/** The "Show usage bar" setting (Settings > General); on unless turned off. */
export function usageBarOn(settings: { show_usage_bar?: boolean } | null | undefined): boolean {
  return settings?.show_usage_bar !== false;
}

/** "Read Claude usage with my Claude sign-in" (Settings > General); on unless turned off, like Orca. */
export function loginReadsOn(settings: { usage_login_reads?: boolean } | null | undefined): boolean {
  return settings?.usage_login_reads !== false;
}

/** `on` is `null` until the settings are read, so a strip that is off never asks the desktop. */
export function useUsageBarOn(): { on: boolean | null; loginReads: boolean } {
  const [prefs, setPrefs] = useState<{ on: boolean | null; loginReads: boolean }>({ on: null, loginReads: true });
  useEffect(() => {
    let live = true;
    const read = () =>
      void loadSettings().then(
        (s) => live && setPrefs({ on: usageBarOn(s), loginReads: loginReadsOn(s) }),
        () => {},
      );
    read();
    let un: UnlistenFn | null = null;
    void listen('settings://changed', read).then(
      (fn) => (live ? (un = fn) : fn()),
      () => {},
    );
    return () => {
      live = false;
      un?.();
    };
  }, []);
  return prefs;
}

/** The snapshot, kept current by `usage://changed`. `refresh()` reads everything again. */
export function useUsage(api: UsageApi = usageApi, enabled = true, loginReads = true) {
  const [snap, setSnap] = useState<UsageSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void api.snapshot(false, loginReads).then(
      (s) => live && setSnap(s),
      () => {},
    );
    let un: UnlistenFn | null = null;
    void api
      .onChanged((s) => live && setSnap(s))
      .then(
        (fn) => (live ? (un = fn) : fn()),
        () => {},
      );
    // Back to the app: ask again (the desktop answers from its cache unless a read is due).
    const onFocus = () =>
      void api.snapshot(false, loginReads).then(
        (s) => live && setSnap(s),
        () => {},
      );
    window.addEventListener('focus', onFocus);
    return () => {
      live = false;
      un?.();
      window.removeEventListener('focus', onFocus);
    };
  }, [api, enabled, loginReads]);
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setSnap(await api.snapshot(true, loginReads));
    } catch {
      /* keep the last numbers */
    } finally {
      setBusy(false);
    }
  }, [api, loginReads]);
  return { snap, busy, refresh };
}
