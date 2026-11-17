// How a phone turn folds its tool steps (D11): every step that went well folds into ONE line ("Worked 4 min · 12 steps")
// at the place of the first one; a step that failed is never folded: it stays where it happened, as its own row.
// Helper rows (an agent started another agent) are rows of their own too. Pure code.
import type { ToolStep, TurnStep } from '../../lib/sessionChatModel';
import { questionsOfCall } from '../chat/questionCall';
import { kindOfCall } from '../chat/chatActivity';
import { t } from '../../i18n';

export type TurnPiece =
  | { kind: 'fold'; id: string; steps: ToolStep[] }
  | { kind: 'failed'; step: ToolStep }
  /** The agent asks the person a question with options: a card of its own, whatever the status. */
  | { kind: 'ask'; step: ToolStep }
  | { kind: 'step'; step: TurnStep };

export function foldTurnSteps(steps: readonly TurnStep[]): TurnPiece[] {
  const folded: ToolStep[] = steps.filter((s): s is ToolStep => s.kind === 'tool' && !s.call.helper && s.status !== 'error' && !questionsOfCall(s.call));
  const pieces: TurnPiece[] = [];
  let placed = false;
  for (const step of steps) {
    if (step.kind !== 'tool' || step.call.helper) {
      pieces.push({ kind: 'step', step });
    } else if (questionsOfCall(step.call)) {
      pieces.push({ kind: 'ask', step });
    } else if (step.status === 'error') {
      pieces.push({ kind: 'failed', step });
    } else if (!placed) {
      placed = true;
      pieces.push({ kind: 'fold', id: step.id, steps: folded });
    }
  }
  return pieces;
}

// The live line: one plain line for the step that runs now. A muted verb, then the one bright thing it works on
// (a file name). The command text of a shell step is never shown; a test command says "Running tests".
export interface LiveLine {
  verb: string;
  /** The bright part: a file's name, or null when the verb says it all. */
  thing: string | null;
}

const TEST_COMMAND = /\b(?:tests?|vitest|jest|pytest|mocha|cargo\s+test)\b/i;

function fileName(path: string): string {
  return path.split(/[\\/]/).filter((part) => part !== '').pop() ?? path;
}

/** The newest step still running, or null when none runs. */
export function runningStep(steps: readonly ToolStep[]): ToolStep | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.status === 'running') return step;
  }
  return null;
}

/** The words for one running step. Built from the step's kind and file path only, never from the command text. */
export function liveLine(step: ToolStep): LiveLine {
  const kind = kindOfCall(step.call);
  const path = (step.call.paths ?? []).find((p) => typeof p === 'string' && p !== '');
  const file = path !== undefined ? fileName(path) : t('phone.live.files');
  switch (kind) {
    case 'read':
      return { verb: t('phone.live.verb.read'), thing: file };
    case 'edit':
      return { verb: t('phone.live.verb.edit'), thing: file };
    case 'write':
      return { verb: t('phone.live.verb.write'), thing: file };
    case 'search':
      return { verb: t('phone.live.verb.search'), thing: null };
    case 'run':
      return TEST_COMMAND.test(step.call.summary ?? '')
        ? { verb: t('phone.live.verb.tests'), thing: null }
        : { verb: t('phone.live.verb.run'), thing: null };
    case 'web':
      return { verb: t('phone.live.verb.web'), thing: null };
    case 'helper':
      return { verb: t('phone.live.verb.helper'), thing: null };
    default:
      return { verb: t('phone.live.verb.other'), thing: null };
  }
}

/** The live line as one string ("Reading login.ts", "Running tests"). */
export function liveText(line: LiveLine): string {
  return line.thing === null ? line.verb : `${line.verb} ${line.thing}`;
}
