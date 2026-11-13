// Settings > General > About: "Restore the last good settings". The app keeps up to five saved copies of the settings
// file. If the file was damaged when the app started, a line says so and offers the restore first.
import { useEffect, useState } from 'react';
import { t, useT } from '../../../i18n';
import { errorSentence } from '../../../lib/sayError';
import { RECOVERY_HINT, RECOVERY_LABEL, settingsRecoveryApi, type SettingsRecoveryApi, type SettingsRecoveryStatus } from '../../../lib/settings-recovery';
import { Btn, Note, SettingRow } from '../settings-ui';

export function SettingsRecoveryRow({ api = settingsRecoveryApi, onSaved }: { api?: SettingsRecoveryApi; onSaved?: () => void }) {
  const t = useT();
  const [status, setStatus] = useState<SettingsRecoveryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .status()
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus(null));
    return () => {
      alive = false;
    };
  }, [api]);

  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.restore();
      setDone(true);
      setStatus((s) => (s ? { ...s, damaged: false } : s));
      onSaved?.();
    } catch (e) {
      setError(errorSentence(e, t('settings.damaged.failed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingRow label={t('settings.row.settings-recovery.label')} description={t('settings.row.settings-recovery.hint')}>
      <div className="app-update-row">
        <Btn disabled={busy || !status?.hasBackup} onClick={() => void restore()}>
          {busy ? t('settings.damaged.restoring') : t('settings.row.settings-recovery.label')}
        </Btn>
        {status && !status.hasBackup && <Note>{t('recovery.none')}</Note>}
        {done && <Note>{t('recovery.done')}</Note>}
        {error && <Note role="alert">{error}</Note>}
      </div>
    </SettingRow>
  );
}
