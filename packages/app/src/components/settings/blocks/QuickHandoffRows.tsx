// Settings > Agents > Handoff: "Hand off does" (Quick handoff or Handoff to new agent) and "Fixed notes for every
// handoff" (used by both). Both save through env.patch; the Hand off button reads them (hooks/useHandoff).
import { DEFAULT_HANDOFF_MODE, type HandoffMode } from '../../../lib/handoff';
import { Popup, TextAreaControl } from '../controls';
import type { SettingsEnv } from '../model';
import { SettingBlock, SettingRow } from '../settings-ui';

export const HANDOFF_MODE_LABEL = 'Hand off does';
export const HANDOFF_MODE_HINT = 'Quick handoff saves HANDOFF.md. Handoff to new agent opens a fresh agent.';
export const HANDOFF_MODES: ReadonlyArray<{ value: HandoffMode; label: string }> = [
  { value: 'new_agent', label: 'Handoff to new agent' },
  { value: 'file', label: 'Quick handoff' },
];
export const FIXED_NOTES_LABEL = 'Fixed notes for every handoff';
export const FIXED_NOTES_HINT = 'Added to the end of every handoff, under Always remember.';

export function QuickHandoffRows({ env }: { env: SettingsEnv }) {
  const mode: HandoffMode = env.settings.handoff_mode ?? DEFAULT_HANDOFF_MODE;
  return (
    <>
      <SettingRow label={HANDOFF_MODE_LABEL} description={HANDOFF_MODE_HINT}>
        <Popup aria-label={HANDOFF_MODE_LABEL} value={mode} onChange={(event) => void env.patch({ handoff_mode: event.target.value as HandoffMode })}>
          {HANDOFF_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </Popup>
      </SettingRow>
      <SettingBlock label={FIXED_NOTES_LABEL} description={FIXED_NOTES_HINT}>
        <TextAreaControl
          aria-label={FIXED_NOTES_LABEL}
          placeholder="For example: Reply in short sentences. Never push without asking."
          value={env.settings.handoff_fixed_notes ?? ''}
          onCommit={(next) => env.patch({ handoff_fixed_notes: next })}
        />
      </SettingBlock>
    </>
  );
}
