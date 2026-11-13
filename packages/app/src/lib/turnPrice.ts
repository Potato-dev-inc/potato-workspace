// The price tag under a finished answer: how long it took, how many steps, which files it changed, and (when the
// agent reported its token counts) about how many tokens it added. Built only from what the chat already holds; no
// model call. A turn far above what is usual for the same chat is marked "heavy". Pure code.
import { classifyTool } from './chatToolKinds';
import type { ChatTurn, ToolStep } from './sessionChatModel';

/** The least tokens a turn must add before the tag mentions tokens: smaller numbers are noise. */
export const MIN_TOKENS_SHOWN = 1000;
/** A turn is compared with the others only when the chat has at least this many other finished turns. */
export const MIN_OTHER_TURNS = 3;
/** A turn is heavy at this many times the usual (the middle value of the other turns) or more... */
export const HEAVY_FACTOR = 3;
/** ...and only past these floors, so a quick chat never marks a short turn. */
export const HEAVY_MIN_STEPS = 12;
export const HEAVY_MIN_MS = 120_000;
/** A heavy turn that mostly read files gets the "name the file" tip from this many files. */
export const READS_TIP_MIN = 8;

export type HeavyReason = 'reads' | 'long';

export interface TurnPrice {
  durationMs: number | null;
  steps: number;
  /** Files the turn changed (an edit or a write), each once. */
  files: string[];
  /** Files it only read, each once. */
  reads: number;
  /** About how many tokens the turn added to the conversation window; null when unknown or small. */
  tokens: number | null;
  heavy: HeavyReason | null;
}

function toolSteps(turn: ChatTurn): ToolStep[] {
  return turn.steps.filter((step): step is ToolStep => step.kind === 'tool');
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The files a list of tool steps changed (`writes`), each once, in order. */
export function changedFiles(steps: readonly ToolStep[]): string[] {
  const seen = new Set<string>();
  for (const step of steps) {
    if (step.call.writes !== true) continue;
    for (const path of step.call.paths ?? []) if (typeof path === 'string' && path !== '') seen.add(path);
  }
  return [...seen];
}

/** A price for each finished turn that did something (a step, or a changed file). Turns still running have none. */
export function turnPrices(turns: readonly ChatTurn[]): Map<string, TurnPrice> {
  const prices = new Map<string, TurnPrice>();
  let before = 0;
  const base: Array<{ id: string; steps: number; ms: number | null }> = [];
  for (const turn of turns) {
    const tokensNow = turn.contextTokens;
    const grew = typeof tokensNow === 'number' ? tokensNow - before : null;
    if (typeof tokensNow === 'number') before = tokensNow;
    if (turn.end === null) continue;
    const tools = toolSteps(turn);
    const reads = new Set<string>();
    for (const step of tools) if (classifyTool({ name: step.call.name, summary: step.call.summary, input: step.call.input, writes: step.call.writes, helper: step.call.helper }) === 'read') for (const path of step.call.paths ?? []) reads.add(path);
    prices.set(turn.id, {
      durationMs: turn.durationMs,
      steps: tools.length,
      files: changedFiles(tools),
      reads: reads.size,
      tokens: grew !== null && grew >= MIN_TOKENS_SHOWN ? grew : null,
      heavy: null,
    });
    base.push({ id: turn.id, steps: tools.length, ms: turn.durationMs });
  }
  for (const [id, price] of prices) {
    const others = base.filter((b) => b.id !== id && b.steps > 0);
    if (others.length < MIN_OTHER_TURNS) continue;
    const usualSteps = median(others.map((o) => o.steps));
    const times = others.map((o) => o.ms).filter((ms): ms is number => ms !== null);
    const usualMs = times.length >= MIN_OTHER_TURNS ? median(times) : null;
    const manySteps = price.steps >= HEAVY_MIN_STEPS && price.steps >= HEAVY_FACTOR * usualSteps;
    const longTime = price.durationMs !== null && usualMs !== null && price.durationMs >= HEAVY_MIN_MS && price.durationMs >= HEAVY_FACTOR * usualMs;
    if (!manySteps && !longTime) continue;
    price.heavy = price.reads >= READS_TIP_MIN && price.reads * 2 >= price.steps ? 'reads' : 'long';
  }
  return prices;
}

/** Whether a price says anything worth a line. */
export function hasPrice(price: TurnPrice | undefined): price is TurnPrice {
  return !!price && (price.steps > 0 || price.files.length > 0);
}
