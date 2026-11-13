// Settings > Agents > Handoff: "Hand off does" (Quick handoff or Handoff to new agent) and "Fixed notes for every
// handoff" (used by both). Both save through env.patch; the Hand off button reads them (hooks/useHandoff).
import { t, useT } from '../../../i18n';
import { DEFAULT_HANDOFF_MODE, type HandoffMode } from '../../../lib/handoff';
import { Popup, TextAreaControl } from '../controls';
import type { SettingsEnv } from '../model';
import { SettingBlock, SettingRow } from '../settings-ui';

export const HANDOFF_MODE_LABEL = 'Hand off does';
export const HANDOFF_MODE_HINT = 'Quick handoff saves HANDOFF.md. Handoff to new agent opens a fresh agent.';
export const HANDOFF_MODES: ReadonlyArray<{ value: HandoffMode; label: string }> = [
  { value: 'new_agent', get label() { return t('overview.handoff.newAgent'); } },
  { value: 'file', get label() { return t('overview.handoff.file'); } },
];
export const FIXED_NOTES_LABEL = 'Fixed notes for every handoff';
export const FIXED_NOTES_HINT = 'Added to the end of every handoff, under Always remember.';

export function QuickHandoffRows({ env }: { env: SettingsEnv }) {
  const t = useT();
  const mode: HandoffMode = env.settings.handoff_mode ?? DEFAULT_HANDOFF_MODE;
  return (
    <>
      <SettingRow label={t('settings.row.handoff-mode.label')} description={t('settings.row.handoff-mode.hint')}>
        <Popup aria-label={t('settings.row.handoff-mode.label')} value={mode} onChange={(event) => void env.patch({ handoff_mode: event.target.value as HandoffMode })}>
          {HANDOFF_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </Popup>
      </SettingRow>
      <SettingBlock label={t('handoff.notes')} description={t('handoff.notesHelp')}>
        <TextAreaControl
          aria-label={t('handoff.notes')}
          placeholder={t('handoff.notesPlaceholder')}
          value={env.settings.handoff_fixed_notes ?? ''}
          onCommit={(next) => env.patch({ handoff_fixed_notes: next })}
        />
      </SettingBlock>
    </>
  );
}
