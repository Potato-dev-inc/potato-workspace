// Settings > General: stuck-agent warnings and the "Stop all agents" shortcut.
import { errorSentence } from '../../../lib/sayError';
import { t, useT } from '../../../i18n';
import { useEffect, useState } from 'react';
import { tauriLoopApi, type LoopGuardApi, type LoopGuardSettings } from '../../../lib/loop-guard';
import { bindingLabel } from '../../../lib/shortcuts';
import { FieldSelect, SettingRow, SettingToggle } from '../settings-ui';

export function LoopGuardSettingsBlock({ api = tauriLoopApi, onSaved }: { api?: LoopGuardApi; onSaved?: () => void }) {
  const t = useT();
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
        setError(t('settings.notSaved', { reason: errorSentence(e) }));
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
        label={t('settings.row.loop-guard.label')}
        description={t('loopGuard.help')}
        checked={s.enabled}
        onChange={(enabled) => save({ ...s, enabled })}
      />
      <SettingRow label={t('loopGuard.sens')} description={t('loopGuard.sensHelp')}>
        <FieldSelect value={String(s.turns)} disabled={!s.enabled} onChange={(e) => save({ ...s, turns: Number(e.target.value) })}>
          <option value="3">{t('loopGuard.early')}</option>
          <option value="4">{t('loopGuard.balanced')}</option>
          <option value="6">{t('loopGuard.careful')}</option>
          <option value="8">{t('loopGuard.veryCareful')}</option>
        </FieldSelect>
      </SettingRow>
      <SettingRow label={t('loopGuard.quiet')} description={t('loopGuard.quietHelp')}>
        <FieldSelect
          value={String(s.stalled_minutes)}
          disabled={!s.enabled}
          onChange={(e) => save({ ...s, stalled_minutes: Number(e.target.value) })}
        >
          {[10, 20, 30, 60].map((m) => (
            <option key={m} value={m}>
              {t('loopGuard.minutes', { m })}
            </option>
          ))}
        </FieldSelect>
      </SettingRow>
      <SettingToggle
        label={t('loopGuard.stopAll')}
        description={t('loopGuard.stopAllHelp', { keys: bindingLabel('stop-all') || t('loopGuard.aShortcut') })}
        checked={s.panic_shortcut}
        onChange={(panic_shortcut) => save({ ...s, panic_shortcut })}
      />
    </>
  );
}
