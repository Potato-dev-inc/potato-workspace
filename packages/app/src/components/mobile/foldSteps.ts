// How a phone turn folds its tool steps (D11): every step that went well folds into ONE line ("Worked 4 min · 12 steps")
// at the place of the first one; a step that failed is never folded: it stays where it happened, as its own row.
// Helper rows (an agent started another agent) are rows of their own too. Pure code.
import type { ToolStep, TurnStep } from '../../lib/sessionChatModel';

export type TurnPiece =
  | { kind: 'fold'; id: string; steps: ToolStep[] }
  | { kind: 'failed'; step: ToolStep }
  | { kind: 'step'; step: TurnStep };

export function foldTurnSteps(steps: readonly TurnStep[]): TurnPiece[] {
  const folded: ToolStep[] = steps.filter((s): s is ToolStep => s.kind === 'tool' && !s.call.helper && s.status !== 'error');
  const pieces: TurnPiece[] = [];
  let placed = false;
  for (const step of steps) {
    if (step.kind !== 'tool' || step.call.helper) {
      pieces.push({ kind: 'step', step });
    } else if (step.status === 'error') {
      pieces.push({ kind: 'failed', step });
    } else if (!placed) {
      placed = true;
      pieces.push({ kind: 'fold', id: step.id, steps: folded });
    }
  }
  return pieces;
}
