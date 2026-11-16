// Settings > Agents > Limits: what the current project may use in a day (turns, agent minutes, and a share of the plan),
// and the switch for the "try a model that fits" line after a turn. Off by default (0 = no limit). A project at a limit
// holds back NEW turns only; a turn that is running always finishes (`project_budget` in the app).
// The turns and minutes share one picker (No limit, Light, Normal, Heavy; Custom opens all three numbers).
import { useEffect, useState } from 'react';
import { t, useT } from '../../../i18n';
import { tauri, type ProjectBudgetLimits } from '../../../lib/tauri';
import { NumberControl } from '../controls';
import type { RowDef } from '../model';
import { SettingBlock, SettingToggle } from '../settings-ui';
import { LimitPresetPicker, type PresetTable } from './LimitPresets';

const NONE: ProjectBudgetLimits = { turnsPerDay: null, minutesPerDay: null, planPercent: null };

export const clampDayTurns = (n: number): number => (Number.isFinite(n) ? Math.min(10000, Math.max(0, Math.round(n))) : 0);
export const clampDayMinutes = (n: number): number => (Number.isFinite(n) ? Math.min(1440, Math.max(0, Math.round(n))) : 0);
export const clampPlanPercent = (n: number): number => (Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0);

/** What each preset sets for one day. 0 means no limit (saved as null). */
export const PROJECT_PRESETS: PresetTable<{ turns: number; minutes: number }> = {
  none: { turns: 0, minutes: 0 },
  light: { turns: 100, minutes: 60 },
  normal: { turns: 500, minutes: 240 },
  heavy: { turns: 2000, minutes: 720 },
};

function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function ProjectBudgetControls({ project, onSaved }: { project: string | null; onSaved: () => void }) {
  const tr = useT();
  const [limits, setLimits] = useState<ProjectBudgetLimits | null>(null);

  useEffect(() => {
    setLimits(null);
    if (!project) return;
    let live = true;
    tauri.projectBudgetLimits(project).then(
      (next) => live && setLimits(next ?? NONE),
      () => live && setLimits(NONE),
    );
    return () => {
      live = false;
    };
  }, [project]);

  if (!project) return <span className="st-aside">{tr('projectBudget.noProject')}</span>;
  if (!limits) return null;

  const save = async (patch: Partial<ProjectBudgetLimits>) => {
    const kept = await tauri.projectBudgetSet(project, { ...limits, ...patch });
    setLimits(kept);
    onSaved();
  };
  const zeroIsNone = (n: number) => (n > 0 ? n : null);
  const pair = { turns: limits.turnsPerDay ?? 0, minutes: limits.minutesPerDay ?? 0 };

  return (
    <div className="st-pb-controls">
      <span className="st-aside">{tr('projectBudget.forProject', { project: folderName(project) })}</span>
      <LimitPresetPicker
        table={PROJECT_PRESETS}
        value={pair}
        same={(a, b) => a.turns === b.turns && a.minutes === b.minutes}
        aria={tr('projectBudget.presetAria')}
        onPick={(name) => void save({ turnsPerDay: zeroIsNone(PROJECT_PRESETS[name].turns), minutesPerDay: zeroIsNone(PROJECT_PRESETS[name].minutes) })}
        custom={
          <>
            <NumberControl
              aria-label={tr('projectBudget.turnsAria')}
              min={0}
              max={10000}
              value={pair.turns}
              normalize={clampDayTurns}
              suffix={tr('projectBudget.turnsSuffix')}
              onCommit={(n) => save({ turnsPerDay: zeroIsNone(n) })}
            />
            <NumberControl
              aria-label={tr('projectBudget.minutesAria')}
              min={0}
              max={1440}
              value={pair.minutes}
              normalize={clampDayMinutes}
              suffix={tr('projectBudget.minutesSuffix')}
              onCommit={(n) => save({ minutesPerDay: zeroIsNone(n) })}
            />
            <NumberControl
              aria-label={tr('projectBudget.planAria')}
              min={0}
              max={100}
              value={limits.planPercent ?? 0}
              normalize={clampPlanPercent}
              suffix={tr('projectBudget.planSuffix')}
              onCommit={(n) => save({ planPercent: zeroIsNone(n) })}
            />
          </>
        }
      />
    </div>
  );
}

export const projectBudgetRows: RowDef[] = [
  {
    id: 'project-budget',
    label: 'Budget for this project',
    hint: 'What this project may use in a day. At a limit, new turns wait. 0 means no limit.',
    keywords: 'budget limit project day daily cost turns minutes plan percent pause spend preset light normal heavy',
    group: 'Limits',
    render: (env) => (
      <SettingBlock label={t('settings.row.project-budget.label')} description={t('settings.row.project-budget.hint')}>
        <ProjectBudgetControls project={env.projectPath} onSaved={env.markSaved} />
      </SettingBlock>
    ),
  },
  {
    id: 'right-size',
    label: 'Suggest a model that fits',
    hint: 'After a turn, a quiet line may suggest a cheaper or stronger model. Once a day per chat.',
    keywords: 'model suggest cheaper stronger smaller haiku right size cost fit hint',
    group: 'Limits',
    render: (env) => (
      <SettingToggle
        label={t('settings.row.right-size.label')}
        description={t('settings.row.right-size.hint')}
        checked={env.settings.right_size_suggest ?? true}
        onChange={(value) => void env.patch({ right_size_suggest: value })}
      />
    ),
  },
];
