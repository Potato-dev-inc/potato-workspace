// "Why did it stop?" for an agent that stopped with an error (UX-PHASE1 12.1, audit P1-13).
// Every card says three things: what happened, what is safe, and one next step. The code never
// appears in the text (it goes in a tooltip); the agent's name comes from its label, so nothing
// here knows an agent.

import { t } from '../../i18n';

export type ErrorFix = 'start_again' | 'install' | 'open_pane';

export interface ErrorExplanation {
  /** The card's title: what happened, verb first. */
  title: string;
  /** What is safe and what to do, in one or two short sentences. */
  sentence: string;
  fix: ErrorFix;
  /** Label of the one fix button. */
  fixLabel: string;
  /**
   * `error` is the (x) glyph: something broke. `notice` is the calm one: the person chose this
   * (they declined a folder), so it is not drawn as a failure.
   */
  glyph: 'error' | 'notice';
}

const fixLabel = (fix: ErrorFix): string => t(fix === 'start_again' ? 'risk.error.startAgain' : fix === 'install' ? 'risk.error.install' : 'risk.error.open');

function explanation(title: string, sentence: string, fix: ErrorFix, glyph: ErrorExplanation['glyph'] = 'error'): ErrorExplanation {
  return { title, sentence, fix, fixLabel: fixLabel(fix), glyph };
}

/** The title, sentence and fix for a run error code, or null for a code with no sentence yet. */
export function explainError(code: string | null | undefined, agent: string): ErrorExplanation | null {
  switch (code) {
    case 'WORKSPACE_TRUST_DECLINED':
      // Starting again asks about the folder again; Potato Workspace never answers that question for you.
      return explanation(
        t('risk.error.declined.title', { agent }),
        t('risk.error.declined.sentence'),
        'start_again',
        'notice',
      );
    case 'AGENT_EXITED':
      return explanation(t('risk.error.exited.title', { agent }), t('risk.error.exited.sentence'), 'start_again');
    case 'AGENT_NOT_INSTALLED':
      return explanation(t('risk.error.notInstalled.title', { agent }), t('risk.error.notInstalled.sentence'), 'install');
    case 'PANE_NOT_READY':
      return explanation(t('risk.error.notReady.title', { agent }), t('risk.error.notReady.sentence'), 'open_pane');
    case 'PROMPT_NOT_SUBMITTED':
      return explanation(t('risk.error.notSubmitted.title', { agent }), t('risk.error.notSubmitted.sentence'), 'open_pane');
    default:
      return null;
  }
}

/** The title and sentence when the run gave no code we can explain. */
export function unknownError(agent: string): { title: string; sentence: string } {
  return { title: t('risk.error.exited.title', { agent }), sentence: t('risk.error.unknown.sentence') };
}
