// The numbers of the Speed report (Settings > General): one row per measured time, with a "slow" marker when the
// usual time is above what feels fine. Pure; the block draws it and "Copy for support" prints it as plain text.
import { t } from '../../../i18n';
import type { PerfStat, PerfSummary } from '../../../lib/tauri';

/** A usual time above this (ms) is marked slow. */
export const SLOW_MS = {
  appStart: 5000,
  chatWarm: 1500,
  chatCold: 6000,
  handshake: 5000,
  firstReply: 8000,
  setupCheck: 5000,
  /** One step of the app start. */
  startupStep: 1000,
} as const;

/** Fewer than this share of chat starts using a ready session is marked low (once there are enough starts). */
export const LOW_WARM_SHARE = 0.3;
export const WARM_MIN_STARTS = 5;

export interface SpeedRow {
  id: string;
  label: string;
  usual: string;
  last: string;
  times: string;
  slow: boolean;
  /** The marker word when `slow` ("Slow", or "Low" for the warm share). */
  mark: string;
}

export function formatMs(ms: number): string {
  return ms < 950 ? t('speed.ms', { n: Math.round(ms / 10) * 10 }) : t('speed.s', { n: (ms / 1000).toFixed(1) });
}

const DASH = '-';

function statRow(id: string, label: string, stat: PerfStat, slowAt: number): SpeedRow | null {
  if (stat.count === 0 || stat.medianMs === null) return null;
  return {
    id,
    label,
    usual: formatMs(stat.medianMs),
    last: stat.lastMs === null ? DASH : formatMs(stat.lastMs),
    times: String(stat.count),
    slow: stat.medianMs > slowAt,
    mark: t('speed.slow'),
  };
}

/** The rows to show, in a fixed order; a time that was never measured has no row. */
export function speedRows(summary: PerfSummary): SpeedRow[] {
  const rows: (SpeedRow | null)[] = [];
  const total = summary.startupTotalMs;
  if (total !== null && total !== undefined) {
    rows.push({ id: 'startupTotal', label: t('speed.line.startupTotal'), usual: formatMs(total), last: DASH, times: '1', slow: total > SLOW_MS.appStart, mark: t('speed.slow') });
  } else {
    rows.push(statRow('appStart', t('speed.line.appStart'), summary.appStart, SLOW_MS.appStart));
  }
  for (const step of summary.startupSteps ?? []) {
    if (step.stepMs < 50 && step.stepMs <= SLOW_MS.startupStep) continue;
    rows.push({ id: `step:${step.name}`, label: t('speed.line.startupStep', { name: step.name.replace(/_/g, ' ') }), usual: formatMs(step.stepMs), last: DASH, times: '1', slow: step.stepMs > SLOW_MS.startupStep, mark: t('speed.slow') });
  }
  rows.push(
    statRow('chatWarm', t('speed.line.chatWarm'), summary.chatWarm, SLOW_MS.chatWarm),
    statRow('chatCold', t('speed.line.chatCold'), summary.chatCold, SLOW_MS.chatCold),
    statRow('handshake', t('speed.line.handshake'), summary.handshake, SLOW_MS.handshake),
    statRow('firstReply', t('speed.line.firstReply'), summary.firstReply, SLOW_MS.firstReply),
    statRow('setupCheck', t('speed.line.setupCheck'), summary.setupCheck, SLOW_MS.setupCheck),
  );
  const starts = (summary.warmHits ?? 0) + (summary.warmMisses ?? 0);
  if (starts > 0) {
    rows.push({
      id: 'warm',
      label: t('speed.line.warm'),
      usual: t('speed.warm.value', { hits: summary.warmHits, total: starts }),
      last: DASH,
      times: String(starts),
      slow: starts >= WARM_MIN_STARTS && summary.warmHits / starts < LOW_WARM_SHARE,
      mark: t('speed.low'),
    });
  }
  return rows.filter((r): r is SpeedRow => r !== null);
}

/** The report as plain text for a support message: numbers and names of steps only. */
export function speedText(rows: SpeedRow[]): string {
  const lines = rows.map((r) => `${r.label}: ${r.usual}${r.last !== DASH ? ` (last ${r.last})` : ''}, seen ${r.times}${r.slow ? ` [${r.mark}]` : ''}`);
  return [t('speed.report.heading'), ...lines].join('\n');
}
