// The result card of the phone (P10): helpers that turn a finished turn and the PC's `GET /panes/{id}/result` answer into
// the few things the card shows. When the PC has no summary for a turn, the card falls back to what the chat itself shows:
// the files the agent's tool calls changed. Pure code.
import type { ChatTurn, ToolStep } from './sessionChatModel';
import type { PaneResult } from './phone-upload';

export interface ResultFile {
  path: string;
  added: number | null;
  deleted: number | null;
  status: string | null;
}

/** The files the turn changed, from the PC when it said, else from the tool calls that wrote (no counts then). */
export function resultFiles(turn: ChatTurn, result: PaneResult | null): ResultFile[] {
  if (result?.available && result.changes && result.changes.length > 0) {
    return result.changes.map((c) => ({ path: c.path, added: c.binary ? null : c.added, deleted: c.binary ? null : c.deleted, status: c.status }));
  }
  const seen = new Set<string>();
  const files: ResultFile[] = [];
  for (const step of turn.steps) {
    if (step.kind !== 'tool') continue;
    const call = (step as ToolStep).call;
    if (call.writes !== true) continue;
    for (const path of call.paths ?? []) {
      if (seen.has(path)) continue;
      seen.add(path);
      files.push({ path, added: null, deleted: null, status: null });
    }
  }
  return files;
}

/** Markdown made plain for a short summary: no code ticks, bold marks, headings or list dashes. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** What the agent said last in the turn (its closing words, as plain text), or null. */
export function lastAnswer(turn: ChatTurn): string | null {
  for (let i = turn.steps.length - 1; i >= 0; i -= 1) {
    const step = turn.steps[i]!;
    if (step.kind === 'text' && step.item.text.trim() !== '') return plainText(step.item.text) || null;
  }
  return null;
}

/** Totals for the "2 files · +48 −12" line. Counts are null when the PC gave none. */
export function totals(files: readonly ResultFile[], result: PaneResult | null): { count: number; added: number | null; deleted: number | null } {
  if (result?.available && result.files) return { count: result.files.count, added: result.files.added, deleted: result.files.deleted };
  const counted = files.every((f) => f.added !== null);
  return {
    count: files.length,
    added: counted && files.length > 0 ? files.reduce((n, f) => n + (f.added ?? 0), 0) : null,
    deleted: counted && files.length > 0 ? files.reduce((n, f) => n + (f.deleted ?? 0), 0) : null,
  };
}

export interface DiffFile {
  path: string;
  lines: string[];
}

/** Splits a unified diff into one block per file. A diff with no file header is one block with no path. */
export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of patch.split('\n')) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      current = { path: head[2]!, lines: [] };
      files.push(current);
      continue;
    }
    if (!current) {
      if (line === '') continue;
      current = { path: '', lines: [] };
      files.push(current);
    }
    current.lines.push(line);
  }
  return files;
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'plain';

export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'plain';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  if (line.startsWith('@@')) return 'hunk';
  return 'plain';
}

/** The plain text the Share button hands over: the summary and the files. */
export function shareText(summary: string, files: readonly ResultFile[]): string {
  const list = files.map((f) => (f.added !== null ? `${f.path} (+${f.added} −${f.deleted ?? 0})` : f.path));
  return [summary, ...list].filter((part) => part !== '').join('\n');
}

const KEPT_KEY = 'pm.phone.resultKept';

/** The turn the person pressed Keep on, per chat. */
export function keptTurn(paneId: string): string | null {
  try {
    const all = JSON.parse(localStorage.getItem(KEPT_KEY) ?? '{}') as Record<string, string>;
    return typeof all[paneId] === 'string' ? all[paneId]! : null;
  } catch {
    return null;
  }
}

export function keepTurn(paneId: string, turnId: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEPT_KEY) ?? '{}') as Record<string, string>;
    all[paneId] = turnId;
    const keys = Object.keys(all);
    if (keys.length > 50) delete all[keys[0]!];
    localStorage.setItem(KEPT_KEY, JSON.stringify(all));
  } catch {
    /* private mode: the card comes back next time */
  }
}
