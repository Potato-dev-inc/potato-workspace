// The highlights bundled with the app. All three surfaces (the after-update card, the tour, the Feature guide)
// read from here. A version's file is shown by the tour only when it equals the running version. No network.
import { t, type MessageKey } from '../i18n';
import v111 from './highlights/1.1.1.json';
import guideFile from './highlights/guide.json';
import { TOUR_MIN, type Highlight, type HighlightsFile, type Platform } from './types';

/** One file per version. Add the next version's file here. */
export const VERSION_FILES: readonly HighlightsFile[] = [v111 as HighlightsFile];
/** Older features that only the Feature guide lists. */
export const GUIDE_FILE: HighlightsFile = guideFile as HighlightsFile;

export const normalVersion = (v: string | null | undefined): string => (v ?? '').trim().replace(/^v/i, '');

/** Numeric compare of "1.1.1" style versions (missing parts are 0). */
export function compareVersions(a: string, b: string): number {
  const pa = normalVersion(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = normalVersion(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface Filter {
  platform?: Platform;
  /** Whether a Labs switch is on. Absent: every Labs card is listed. */
  labOn?: (key: string) => boolean;
}

function allowed(h: Highlight, f: Filter): boolean {
  const platform = f.platform ?? 'desktop';
  if (h.platforms && !h.platforms.includes(platform)) return false;
  if (h.labs && f.labOn && !f.labOn(h.labs)) return false;
  return true;
}

export const fileFor = (version: string | null | undefined): HighlightsFile | null => VERSION_FILES.find((f) => normalVersion(f.version) === normalVersion(version)) ?? null;

/** The newest bundled version. */
export const latestVersion = (): string => [...VERSION_FILES].sort((a, b) => compareVersions(a.version, b.version)).at(-1)?.version ?? '';

/** The tour for one version, in file order. Empty when there is no file for it. */
export function tourOf(version: string | null | undefined, f: Filter = {}): Highlight[] {
  return (fileFor(version)?.highlights ?? []).filter((h) => h.tour && allowed(h, f));
}

/** Every card of one version that suits the device (tour or not), in file order. The phone's sheet lists these. */
export const highlightsOf = (version: string | null | undefined, f: Filter = {}): Highlight[] => (fileFor(version)?.highlights ?? []).filter((h) => allowed(h, f));

/** Whether the version has enough cards for a tour (fewer than 3: the card shows without a tour button). */
export const hasTour = (version: string | null | undefined, f: Filter = {}): boolean => tourOf(version, f).length >= TOUR_MIN;

/** Every feature for the guide: the versions' cards, newest first, then the guide-only file. */
export function guideEntries(f: Filter = {}): (Highlight & { since: string })[] {
  const files = [...VERSION_FILES].sort((a, b) => compareVersions(b.version, a.version));
  const out: (Highlight & { since: string })[] = [];
  for (const file of files) for (const h of file.highlights) if (allowed(h, f)) out.push({ ...h, since: h.since ?? file.version });
  for (const h of GUIDE_FILE.highlights) if (allowed(h, f)) out.push({ ...h, since: h.since ?? '' });
  return out;
}

/** A card's words: the translation when there is one, else the English text in the file. */
function words(h: Highlight, field: 'title' | 'line' | 'try', fallback: string): string {
  const key = `whatsnew.${h.id}.${field}`;
  const got = t(key as MessageKey);
  return got === key ? fallback : got;
}
export const titleOf = (h: Highlight): string => words(h, 'title', h.title);
export const lineOf = (h: Highlight): string => words(h, 'line', h.line);
export const tryOf = (h: Highlight): string => words(h, 'try', h.tryLabel);
