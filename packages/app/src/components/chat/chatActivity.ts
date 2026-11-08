// The activity line of a turn: consecutive tool rows fold into one line ("Read 6 files · Ran 2 commands"). This file
// groups a turn's steps and writes that line. Pure code.
import type { ToolCallItem, ToolStep, TurnStep } from '../../lib/sessionChatModel';
import { classifyTool, type ToolKind } from '../../lib/chatToolKinds';
import { formatDuration, plural } from './chatFormat';

/** A run of tool rows (one activity line), or one other step (text, a notice, a helper row). */
export type Segment = { kind: 'activity'; id: string; steps: ToolStep[] } | { kind: 'step'; step: TurnStep };

/** A helper row is never folded into a line: it is a row of its own. */
export function segmentSteps(steps: readonly TurnStep[]): Segment[] {
  const out: Segment[] = [];
  for (const step of steps) {
    if (step.kind === 'tool' && !step.call.helper) {
      const last = out[out.length - 1];
      if (last?.kind === 'activity') last.steps.push(step);
      else out.push({ kind: 'activity', id: step.id, steps: [step] });
    } else {
      out.push({ kind: 'step', step });
    }
  }
  return out;
}

export function kindOfCall(call: ToolCallItem): ToolKind {
  return classifyTool({ name: call.name, summary: call.summary, input: call.input, writes: call.writes, helper: call.helper });
}

export interface ActivityCount {
  kind: ToolKind;
  count: number;
}

const FILE_KINDS = new Set<ToolKind>(['read', 'edit', 'write']);

/**
 * How many of each kind, in the order each kind first came. For reads and edits a file counts once however often it
 * was touched; a call with no path counts once.
 */
export function countActivity(steps: readonly ToolStep[]): ActivityCount[] {
  const slots = new Map<ToolKind, { paths: Set<string>; loose: number }>();
  for (const step of steps) {
    const kind = kindOfCall(step.call);
    let slot = slots.get(kind);
    if (!slot) {
      slot = { paths: new Set(), loose: 0 };
      slots.set(kind, slot);
    }
    const paths = (step.call.paths ?? []).filter((path) => typeof path === 'string' && path !== '');
    if (FILE_KINDS.has(kind) && paths.length > 0) for (const path of paths) slot.paths.add(path);
    else slot.loose += 1;
  }
  return [...slots].map(([kind, slot]) => ({ kind, count: slot.paths.size + slot.loose }));
}

const WORDS: Record<ToolKind, (count: number) => string> = {
  read: (n) => `Read ${plural(n, 'file')}`,
  search: (n) => `Searched ${plural(n, 'time')}`,
  edit: (n) => `Edited ${plural(n, 'file')}`,
  write: (n) => `Wrote ${plural(n, 'file')}`,
  run: (n) => `Ran ${plural(n, 'command')}`,
  web: (n) => `Used the web ${plural(n, 'time')}`,
  helper: (n) => `Started ${plural(n, 'helper')}`,
  other: (n) => `Used ${plural(n, 'tool')}`,
};

/** How many rows of each kind ended in an error. A row with no status (read off the screen) never counts. */
function failedByKind(steps: readonly ToolStep[]): Map<ToolKind, number> {
  const failed = new Map<ToolKind, number>();
  for (const step of steps) {
    if (step.status !== 'error') continue;
    const kind = kindOfCall(step.call);
    failed.set(kind, (failed.get(kind) ?? 0) + 1);
  }
  return failed;
}

/** One group of the summary, split so the failed part can be styled: "Ran 2 commands" and "(1 failed)". */
export interface SummaryPart {
  text: string;
  failed: string | null;
}

export function activitySummaryParts(steps: readonly ToolStep[]): SummaryPart[] {
  const failed = failedByKind(steps);
  return countActivity(steps).map((part) => {
    const n = failed.get(part.kind) ?? 0;
    return { text: WORDS[part.kind](part.count), failed: n > 0 ? `(${n} failed)` : null };
  });
}

/** "Read 6 files · Ran 2 commands (1 failed) · Edited 3 files". */
export function activitySummary(steps: readonly ToolStep[]): string {
  return activitySummaryParts(steps)
    .map((part) => (part.failed === null ? part.text : `${part.text} ${part.failed}`))
    .join(' · ');
}

/** The label of the newest running row: its name and summary ("Bash npm test"), or null when none runs. */
export function runningLabel(steps: readonly ToolStep[]): string | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.status === 'running') return `${step.call.name} ${step.call.summary}`.trim();
  }
  return null;
}

/** Milliseconds from the first row's start to the last row's end, when both times are known; else null. */
export function activitySpanMs(steps: readonly ToolStep[]): number | null {
  if (steps.length === 0) return null;
  const first = steps[0]!;
  const last = steps[steps.length - 1]!;
  const start = Date.parse(first.call.at ?? '');
  const end = Date.parse(last.result?.at ?? last.call.at ?? '');
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return end - start;
}

/** The words of one step in the live list: the tool's name and what it works on ("Edit src/a.ts"). */
export function stepLabel(step: ToolStep): string {
  return `${step.call.name} ${step.call.summary}`.trim();
}

/** Milliseconds one step took, when it has both times; else null. */
export function stepElapsedMs(step: ToolStep): number | null {
  const start = Date.parse(step.call.at ?? '');
  const end = Date.parse(step.result?.at ?? '');
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return end - start;
}

/** The folded line of a finished turn: "Done in 14s · 4 steps" (no time when the rows carry none). */
export function doneSummary(steps: readonly ToolStep[]): string {
  const span = activitySpanMs(steps);
  const count = plural(steps.length, 'step');
  return span !== null ? `Done in ${formatDuration(span)} · ${count}` : `Done · ${count}`;
}
