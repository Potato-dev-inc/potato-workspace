// Settings > General > About: "Restore the last good settings". The app keeps up to five saved copies of the settings
// file. If the file was damaged when the app started, a line says so and offers the restore first.
import { useEffect, useState } from 'react';
import { errorSentence } from '../../../lib/sayError';
import { RECOVERY_HINT, RECOVERY_LABEL, settingsRecoveryApi, type SettingsRecoveryApi, type SettingsRecoveryStatus } from '../../../lib/settings-recovery';
import { Btn, Note, SettingRow } from '../settings-ui';

const RESTORE_FAILED = 'Could not bring your settings back.';

export function SettingsRecoveryRow({ api = settingsRecoveryApi, onSaved }: { api?: SettingsRecoveryApi; onSaved?: () => void }) {
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
      setError(errorSentence(e, RESTORE_FAILED));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingRow label={RECOVERY_LABEL} description={RECOVERY_HINT}>
      <div className="app-update-row">
        <Btn disabled={busy || !status?.hasBackup} onClick={() => void restore()}>
          {busy ? 'Restoring…' : RECOVERY_LABEL}
        </Btn>
        {status && !status.hasBackup && <Note>No saved copy yet. One is made after your settings change.</Note>}
        {done && <Note>Your settings are back.</Note>}
        {error && <Note role="alert">{error}</Note>}
      </div>
    </SettingRow>
  );
}
