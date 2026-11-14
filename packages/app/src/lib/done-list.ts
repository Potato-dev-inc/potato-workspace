// "Done means": a short list per project of what must be true when the work is done (the usual two: the build passes,
// the tests pass). The result card shows a tick, a cross or "not checked" for each line, read from what the agent
// already did in its last turn: the build and test commands it ran and whether they failed. No new model call.
import type { ChatTurn, ToolStep } from './sessionChatModel';

export type DoneKind = 'build' | 'test' | 'lint' | 'other';

export interface DoneLine {
  text: string;
  kind: DoneKind;
}

export type DoneState = 'pass' | 'fail' | 'unchecked';

export interface DoneResult {
  line: DoneLine;
  state: DoneState;
  /** A few plain words about a failure ("2 failed"), or empty. */
  detail: string;
}

const KEY = 'pm-done-means:';

const BUILD_WORDS = /\b(build|compile|typecheck|type check|types?)\b|建置|編譯|型別/i;
const TEST_WORDS = /\btests?\b|測試/i;
const LINT_WORDS = /\b(lint|warnings?)\b|警告/i;

/** What kind of check a line the person wrote stands for, by its words (English or Traditional Chinese). */
export function classifyLine(text: string): DoneKind {
  if (TEST_WORDS.test(text)) return 'test';
  if (LINT_WORDS.test(text)) return 'lint';
  if (BUILD_WORDS.test(text)) return 'build';
  return 'other';
}

const BUILD_CMD =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|compile|typecheck|tsc)\b|\btsc\b|\bcargo\s+(?:build|check)\b|\bgo\s+(?:build|vet)\b|\bdotnet\s+build\b|\b(?:vite|next|webpack|rollup)\s+build\b|\b(?:mvn|gradle|gradlew)\b[^\n]*\b(?:compile|build|package)\b|\bmake\b/i;
const TEST_CMD =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|\b(?:vitest|jest|mocha|pytest|rspec|phpunit)\b|\bcargo\s+test\b|\bgo\s+test\b|\bdotnet\s+test\b|\bnpx\s+playwright\s+test\b/i;
const LINT_CMD = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b|\beslint\b|\bcargo\s+clippy\b|\bruff\b|\bflake8\b|\bgolangci-lint\b/i;

const PATTERNS: Partial<Record<DoneKind, RegExp>> = { build: BUILD_CMD, test: TEST_CMD, lint: LINT_CMD };

export function commandOfStep(step: ToolStep): string {
  const input = step.call.input;
  if (input && typeof input === 'object') {
    const command = (input as Record<string, unknown>).command;
    if (typeof command === 'string') return command;
    if (Array.isArray(command) && command.every((p) => typeof p === 'string')) return command.join(' ');
  }
  return step.call.summary ?? '';
}

/** "2 failed" from test output, else empty. */
function failureDetail(step: ToolStep): string {
  const out = step.result?.output ?? '';
  const m = /(\d+)\s+(?:failed|failing|failures?)\b/i.exec(out);
  return m ? `${m[1]} failed` : '';
}

/**
 * Each line against the turn's tool steps: the last matching command decides (it passed, or it failed). A line with
 * no matching command is "not checked": the app never guesses a tick.
 */
export function evaluateDone(lines: readonly DoneLine[], turn: ChatTurn | undefined): DoneResult[] {
  const steps = (turn?.steps ?? []).filter((s): s is ToolStep => s.kind === 'tool' && s.status !== 'running');
  return lines.map((line) => {
    const pattern = PATTERNS[line.kind];
    const ran = pattern ? steps.filter((s) => pattern.test(commandOfStep(s))) : [];
    const last = ran[ran.length - 1];
    if (!last) return { line, state: 'unchecked', detail: '' };
    if (last.status === 'error') return { line, state: 'fail', detail: failureDetail(last) };
    return { line, state: 'pass', detail: '' };
  });
}

/** The lines the person wrote for a project; null when the project uses the usual two. */
export function loadDoneMeans(projectKey: string): string[] | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY + projectKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const lines = parsed.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim().slice(0, 120));
    return lines.length > 0 ? lines.slice(0, 8) : null;
  } catch {
    return null;
  }
}

/** Saves the project's lines; null (or no lines) goes back to the usual two. */
export function saveDoneMeans(projectKey: string, lines: readonly string[] | null): void {
  try {
    const clean = (lines ?? []).map((x) => x.trim()).filter(Boolean);
    if (clean.length === 0) globalThis.localStorage?.removeItem(KEY + projectKey);
    else globalThis.localStorage?.setItem(KEY + projectKey, JSON.stringify(clean.slice(0, 8)));
  } catch {
    /* private mode: the list lasts until the window closes only if the caller keeps it */
  }
}

/** The lines to show: the person's, else the usual two (named by `usual`). */
export function doneLines(custom: readonly string[] | null, usual: { build: string; tests: string }): DoneLine[] {
  if (custom && custom.length > 0) return custom.map((text) => ({ text, kind: classifyLine(text) }));
  return [
    { text: usual.build, kind: 'build' },
    { text: usual.tests, kind: 'test' },
  ];
}
