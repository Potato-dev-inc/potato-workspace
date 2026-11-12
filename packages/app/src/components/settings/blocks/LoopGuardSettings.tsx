// Settings > General: stuck-agent warnings and the "Stop all agents" shortcut.
import { errorSentence } from '../../../lib/sayError';
import { useEffect, useState } from 'react';
import { tauriLoopApi, type LoopGuardApi, type LoopGuardSettings } from '../../../lib/loop-guard';
import { bindingLabel } from '../../../lib/shortcuts';
import { FieldSelect, SettingRow, SettingToggle } from '../settings-ui';

export function LoopGuardSettingsBlock({ api = tauriLoopApi, onSaved }: { api?: LoopGuardApi; onSaved?: () => void }) {
  const [s, setS] = useState<LoopGuardSettings | null>(null);
  useEffect(() => {
    api.settingsGet().then(setS).catch(() => {});
  }, [api]);
  const [error, setError] = useState<string | null>(null);
  if (!s) return null;
  const save = (next: LoopGuardSettings) => {
    const before = s;
    setError(null);
    setS(next);
    api
      .settingsSet(next)
      .then((saved) => {
        setS(saved);
        onSaved?.();
      })
      .catch((e: unknown) => {
        setS(before); // put the old value back: it was not saved
        setError('Not saved: ' + (errorSentence(e)));
      });
  };
  return (
    <>
      {error && (
        <p role="alert" className="text-xs text-pm-err">
          {error}
        </p>
      )}
      <SettingToggle
        label="Warn when an agent seems stuck"
        description="Shows a card when an agent repeats the same error or the same steps, or works for a long time with nothing new."
        checked={s.enabled}
        onChange={(enabled) => save({ ...s, enabled })}
      />
      <SettingRow label="Stuck warning sensitivity" description="How many repeats before the warning. More repeats means fewer false alarms.">
        <FieldSelect value={String(s.turns)} disabled={!s.enabled} onChange={(e) => save({ ...s, turns: Number(e.target.value) })}>
          <option value="3">Early (3 repeats)</option>
          <option value="4">Balanced (4 repeats)</option>
          <option value="6">Careful (6 repeats)</option>
          <option value="8">Very careful (8 repeats)</option>
        </FieldSelect>
      </SettingRow>
      <SettingRow label="Quiet for too long" description="Warn when an agent has been working this long without printing anything new.">
        <FieldSelect
          value={String(s.stalled_minutes)}
          disabled={!s.enabled}
          onChange={(e) => save({ ...s, stalled_minutes: Number(e.target.value) })}
        >
          {[10, 20, 30, 60].map((m) => (
            <option key={m} value={m}>
              {m} minutes
            </option>
          ))}
        </FieldSelect>
      </SettingRow>
      <SettingToggle
        label="Global shortcut: stop all agents"
        description={`${bindingLabel('stop-all') || 'A shortcut'} interrupts every working agent from anywhere. Off by default.`}
        checked={s.panic_shortcut}
        onChange={(panic_shortcut) => save({ ...s, panic_shortcut })}
      />
    </>
  );
}
