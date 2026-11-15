// Small rules for the Files screens: sizes, dates, paths, and the shapes a far device answers. Anything that comes
// from a far device (names, errors) is untrusted text: callers clip it and render it as text only.
import type { CopyResult, FarError } from './devices';

export function isFarError(x: unknown): x is FarError {
  return !!x && typeof x === 'object' && (x as { ok?: unknown }).ok === false;
}

export function isExists(x: unknown): x is { exists: true; name: string } {
  return !!x && typeof x === 'object' && (x as { exists?: unknown }).exists === true;
}

/** The transfer id of a started copy/send; null for anything else. */
export function copyId(r: CopyResult): number | null {
  return !!r && (r as { ok?: unknown }).ok === true && typeof (r as { id?: unknown }).id === 'number' ? (r as { id: number }).id : null;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function unitOf(bytes: number): number {
  let u = 0;
  let v = Math.max(0, bytes);
  while (v >= 1000 && u < UNITS.length - 1) {
    v /= 1000;
    u++;
  }
  return u;
}

function fmt(bytes: number, u: number): string {
  const v = Math.max(0, bytes) / 1000 ** u;
  return v >= 10 || u === 0 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
}

/** `48 MB`. */
export function sizeText(bytes: number): string {
  const u = unitOf(bytes);
  return `${fmt(bytes, u)} ${UNITS[u]}`;
}

/** `12` and `48 MB`: both in the unit of the total. */
export function progressParts(bytes: number, total: number): { done: string; total: string } {
  if (!(total > 0)) return { done: sizeText(bytes), total: '?' };
  const u = unitOf(total);
  return { done: fmt(Math.min(bytes, total), u), total: `${fmt(total, u)} ${UNITS[u]}` };
}

/** `Nov 15`, with the year when it is not this year. */
export function dateText(unixSecs: number, now: Date = new Date()): string {
  if (!(unixSecs > 0)) return '';
  const d = new Date(unixSecs * 1000);
  return d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

export function joinPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

export function lastPart(path: string): string {
  const parts = path.split(/[\\/]+/).filter((x) => x !== '');
  return parts[parts.length - 1] ?? '';
}

/** The root of a chat: the one named like the chat's folder, else the first. */
export function pickRoot(roots: readonly string[], folderName: string): string | null {
  if (folderName && roots.includes(folderName)) return folderName;
  return roots[0] ?? null;
}
