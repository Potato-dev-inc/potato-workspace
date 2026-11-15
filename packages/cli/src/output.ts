/** Output helpers: plain lines, `--json`, and the rule that a secret is never printed. */

export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** A person at a terminal (not an agent window, not a pipe) who can answer y/N. */
  interactive: boolean;
  confirm(question: string): Promise<boolean>;
}

const SECRETISH = /(secret|token|password|passwd|api_?key|credential|private_?key)/i;

/** True for a key name that could hold a secret. Real settings never do; this is a second lock. */
export function looksSecret(key: string): boolean {
  return SECRETISH.test(key);
}

/** A value as one short line. A secret-looking key prints "[hidden]". */
export function show(key: string, value: unknown): string {
  if (looksSecret(key)) return '[hidden]';
  if (value === undefined) return '(not set)';
  return JSON.stringify(value);
}

export interface Change {
  key: string;
  from: unknown;
  to: unknown;
}

export function isNoChange(change: Change): boolean {
  return JSON.stringify(change.from) === JSON.stringify(change.to);
}

/** One line per change: `key: false -> true`. Unchanged keys say so. */
export function diffLines(changes: Change[]): string[] {
  return changes.map((c) =>
    isNoChange(c) ? `${c.key}: ${show(c.key, c.to)} (no change)` : `${c.key}: ${show(c.key, c.from)} -> ${show(c.key, c.to)}`,
  );
}

/** Text table, last column unpadded. */
export function table(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => (r[col] ?? '').length)));
  return rows.map((r) => r.map((cell, col) => (col === r.length - 1 ? cell : cell.padEnd(widths[col]))).join('  ').trimEnd());
}
