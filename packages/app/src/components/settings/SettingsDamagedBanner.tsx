// Top of the Settings page: shown only when settings.json was damaged when the app started. Offers to bring back the
// last good copy (the same restore as Settings > General > About), or to keep what is there now.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import { settingsRecoveryApi, type SettingsRecoveryApi, type SettingsRecoveryStatus } from '../../lib/settings-recovery';
import { Btn, Note } from './settings-ui';

export function SettingsDamagedBanner({ api = settingsRecoveryApi }: { api?: SettingsRecoveryApi }) {
  const t = useT();
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
      setMessage(errorSentence(e, t('settings.damaged.failed')));
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
      <Note>{t('settings.damaged.line')}</Note>
      <div className="app-update-row">
        <Btn disabled={busy || !status.hasBackup} onClick={() => void restore()}>
          {busy ? t('settings.damaged.restoring') : t('settings.row.settings-recovery.label')}
        </Btn>
        <Btn disabled={busy} onClick={() => void keep()}>
          {t('settings.damaged.keep')}
        </Btn>
      </div>
      {!status.hasBackup && <Note>{t('settings.damaged.noCopy')}</Note>}
      {message && <Note role="alert">{message}</Note>}
    </div>
  );
}
