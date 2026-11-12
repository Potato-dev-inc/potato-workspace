// Top of the Settings page: shown only when settings.json was damaged when the app started. Offers to bring back the
// last good copy (the same restore as Settings > General > About), or to keep what is there now.
import { useEffect, useState } from 'react';
import { errorSentence } from '../../lib/sayError';
import { DAMAGED_LINE, RECOVERY_LABEL, settingsRecoveryApi, type SettingsRecoveryApi, type SettingsRecoveryStatus } from '../../lib/settings-recovery';
import { Btn, Note } from './settings-ui';

export function SettingsDamagedBanner({ api = settingsRecoveryApi }: { api?: SettingsRecoveryApi }) {
  const [status, setStatus] = useState<SettingsRecoveryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .status()
      .then((s) => alive && setStatus(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api]);

  if (hidden || !status?.damaged) return null;

  const restore = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await api.restore();
      setHidden(true);
    } catch (e) {
      setMessage(errorSentence(e, 'Could not bring your settings back.'));
    } finally {
      setBusy(false);
    }
  };
  const keep = async () => {
    await api.dismiss().catch(() => undefined);
    setHidden(true);
  };

  return (
    <div className="st-damaged" role="alert">
      <Note>{DAMAGED_LINE}</Note>
      <div className="app-update-row">
        <Btn disabled={busy || !status.hasBackup} onClick={() => void restore()}>
          {busy ? 'Restoring…' : RECOVERY_LABEL}
        </Btn>
        <Btn disabled={busy} onClick={() => void keep()}>
          Keep what I have
        </Btn>
      </div>
      {!status.hasBackup && <Note>There is no saved copy to bring back yet.</Note>}
      {message && <Note role="alert">{message}</Note>}
    </div>
  );
}
