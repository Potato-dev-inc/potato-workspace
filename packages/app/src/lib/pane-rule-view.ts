// What the PC's per-agent remote rule means for this phone (pure). The rule only ever takes away: a phone still needs its own abilities.
import type { PaneRuleView } from './bridge-types';

/** How far the rule lets a phone go in one agent: nothing at all, watch, watch and answer, or everything (no limit). */
export type RuleLimit = 'off' | 'watch' | 'answer';

export function limitOf(rule: PaneRuleView | undefined): RuleLimit | null {
  if (!rule) return null;
  if (!rule.remote) return 'off';
  if (rule.level === 'watch') return 'watch';
  if (rule.level === 'answer') return 'answer';
  return null;
}

/** A phone may type into this agent (stop it, send it messages). */
export const mayType = (rule: PaneRuleView | undefined): boolean => limitOf(rule) === null;

/** A phone may answer this agent's questions. */
export const mayAnswer = (rule: PaneRuleView | undefined): boolean => {
  const limit = limitOf(rule);
  return limit === null || limit === 'answer';
};

/** "Ask the PC" answers, as the phone shows them. */
export type AskState = 'idle' | 'asking' | 'asked' | 'recently' | 'failed';
