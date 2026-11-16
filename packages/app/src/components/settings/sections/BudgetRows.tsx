// Settings > General > Budgets: the default brake for work agents start. Off by default (0): an
// agent run has no budget unless one of these is set or the agent that starts it asks for one.
// A run that reaches a limit pauses before its next turn; it is never stopped mid-turn.
// One picker sets the turns and the time together (No limit, Light, Normal, Heavy); Custom opens the two numbers.
import { t } from '../../../i18n';
import { NumberControl } from '../controls';
import type { RowDef } from '../model';
import { SettingRow } from '../settings-ui';
import { LimitPresetPicker, type PresetTable } from './LimitPresets';

export const clampBudgetTurns = (n: number): number => (Number.isFinite(n) ? Math.min(10000, Math.max(0, Math.round(n))) : 0);
export const clampBudgetMinutes = (n: number): number => (Number.isFinite(n) ? Math.min(10080, Math.max(0, Math.round(n))) : 0);

interface BudgetPair {
  turns: number;
  minutes: number;
}

/** What each preset sets. 0 is no limit. */
export const BUDGET_PRESETS: PresetTable<BudgetPair> = {
  none: { turns: 0, minutes: 0 },
  light: { turns: 50, minutes: 30 },
  normal: { turns: 200, minutes: 120 },
  heavy: { turns: 1000, minutes: 480 },
};

const samePair = (a: BudgetPair, b: BudgetPair) => a.turns === b.turns && a.minutes === b.minutes;

export const budgetRows: RowDef[] = [
  {
    id: 'budget-turns',
    label: 'How much an agent may use',
    hint: 'Pause an agent once it has used this much. Helpers share this budget.',
    keywords: 'budget limit cost turns minutes time pause helpers brake spend preset light normal heavy',
    group: 'Budgets',
    render: (env) => {
      const pair: BudgetPair = { turns: env.settings.budget_default_turns ?? 0, minutes: env.settings.budget_default_minutes ?? 0 };
      const save = (patch: Partial<BudgetPair>) => env.patch({ budget_default_turns: patch.turns ?? pair.turns, budget_default_minutes: patch.minutes ?? pair.minutes });
      return (
        <SettingRow label={t('settings.row.budget-turns.label')} description={t('settings.row.budget-turns.hint')}>
          <LimitPresetPicker
            table={BUDGET_PRESETS}
            value={pair}
            same={samePair}
            aria={t('budget.presetAria')}
            onPick={(name) => void save(BUDGET_PRESETS[name])}
            custom={
              <>
                <NumberControl
                  aria-label={t('budget.turnsAria')}
                  min={0}
                  max={10000}
                  value={pair.turns}
                  normalize={clampBudgetTurns}
                  suffix={t('budget.turnsSuffix')}
                  onCommit={(turns) => save({ turns })}
                />
                <NumberControl
                  aria-label={t('budget.minutesAria')}
                  min={0}
                  max={10080}
                  value={pair.minutes}
                  normalize={clampBudgetMinutes}
                  suffix={t('budget.minSuffix')}
                  onCommit={(minutes) => save({ minutes })}
                />
              </>
            }
          />
        </SettingRow>
      );
    },
  },
];
