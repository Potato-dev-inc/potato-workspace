// What the peek card of a sidebar row says, as plain functions (no React): the current step, how long it has
// run, the files the last turn changed, usage, the last thing it said, and the answers it may take inline.
// Only data the app already has: the activity line, the status clock, the last turn summary, the pane's usage.
import type { PanePrompt, PromptChoice, TurnSummary } from '../../lib/cockpit-api';
import { activityText, type PaneActivity } from '../../lib/pane-activity';
import type { PaneUsage } from '../../lib/pane-usage';
import { quickChoicesFor } from './board/boardModel';
import { formatElapsed } from './model';

/** How long the pointer rests on a row before the card opens. */
export const PEEK_DELAY_MS = 400;
/** How long the card stays after the pointer left the row and the card (so it can cross the gap). */
export const PEEK_GRACE_MS = 200;

export interface PeekInput {
  status: string;
  activity: PaneActivity | undefined;
  /** When the pane entered its status (epoch ms), or undefined. */
  since: number | undefined;
  now: number;
  lastTurn: TurnSummary | undefined;
  usage: PaneUsage | null;
  prompt: PanePrompt | null | undefined;
}

export interface PeekModel {
  /** The current step: the live activity line. Null when there is none for this status. */
  step: string | null;
  /** How long it has been working. Only while it runs. */
  running: string | null;
  /** Files the last turn changed, or null when not known. */
  files: number | null;
  /** Turns and working time, or null when the app has no number. */
  usage: { turns: number; time: string } | null;
  /** The last plain sentence about its work (the last turn). */
  lastLine: string | null;
  /** A waiting question: its words, and the answers that may be given right here (low risk yes/no only). */
  question: { text: string; promptId: string; quick: PromptChoice[] } | null;
  /** Nothing at all to show besides the name. */
  empty: boolean;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export function peekModel(input: PeekInput): PeekModel {
  const { status, now } = input;
  const step = activityText(status, input.activity);
  const running = status === 'running' && input.since ? formatElapsed(now - input.since) : null;
  const files = input.lastTurn?.files ? input.lastTurn.files.count : null;
  const usage = input.usage && input.usage.own.turns > 0 ? { turns: input.usage.own.turns, time: formatElapsed(input.usage.own.busyMs) } : null;
  const lastLine = input.lastTurn?.sentence ? clip(input.lastTurn.sentence, 160) : null;
  const prompt = status === 'waiting_input' ? input.prompt : null;
  const question = prompt && prompt.choices.length > 0 ? { text: clip(prompt.summary || prompt.text, 140), promptId: prompt.promptId, quick: quickChoicesFor(status, prompt) } : null;
  const empty = !step && !running && files === null && !usage && !lastLine && !question;
  return { step, running, files, usage, lastLine, question, empty };
}
