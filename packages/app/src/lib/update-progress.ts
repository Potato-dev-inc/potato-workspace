// The words for a download in progress: "42 MB of 138 MB · 3.1 MB/s · about 30 seconds left". Pure, so tests pin them.
import { t } from '../i18n';
import type { UpdateProgress } from './app-update';

/** A reading of the download: the bytes so far, and how fast they arrive (smoothed). */
export interface DownloadReading extends UpdateProgress {
  /** Bytes per second, or null before there are two readings. */
  speed: number | null;
}

/** No reading for this long while downloading: the page says the download is slow or stopped. */
export const STALL_HINT_MS = 15_000;

const MB = 1024 * 1024;

export function megabytes(bytes: number): string {
  const value = bytes / MB;
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1);
}

/** A new speed from the last two readings, mixed with the old one so it does not jump. */
export function nextSpeed(prev: { downloaded: number; at: number } | null, now: { downloaded: number; at: number }, old: number | null): number | null {
  if (!prev) return old;
  const seconds = (now.at - prev.at) / 1000;
  if (seconds <= 0 || now.downloaded < prev.downloaded) return old;
  const instant = (now.downloaded - prev.downloaded) / seconds;
  return old === null ? instant : old * 0.6 + instant * 0.4;
}

/** Seconds left at this speed, or null when it cannot be told. */
export function secondsLeft(reading: DownloadReading): number | null {
  if (reading.total === null || reading.speed === null || reading.speed <= 0) return null;
  return Math.max(0, Math.ceil((reading.total - reading.downloaded) / reading.speed));
}

function timeLeft(seconds: number): string {
  if (seconds < 60) return t('overview.update.secondsLeft', { count: Math.max(1, seconds) });
  return t('overview.update.minutesLeft', { count: Math.ceil(seconds / 60) });
}

/** The one line under "Downloading". Parts it cannot know are left out. */
export function downloadLine(reading: DownloadReading): string {
  const size = reading.total
    ? t('overview.update.sizeOf', { done: megabytes(reading.downloaded), total: megabytes(reading.total) })
    : t('overview.update.sizeSoFar', { done: megabytes(reading.downloaded) });
  const parts = [size];
  if (reading.speed !== null && reading.speed > 0) parts.push(t('overview.update.speed', { speed: megabytes(reading.speed) }));
  const left = secondsLeft(reading);
  if (left !== null) parts.push(timeLeft(left));
  return parts.join(t('overview.update.sep'));
}
