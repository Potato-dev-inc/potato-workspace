// One paired device: its name, how it is connected, what it may do on this PC (off after pairing), Remove.
// The words are from the giver's side: this switch says what that device may do HERE. A device cannot turn it on itself.
import { useState } from 'react';
import { useT } from '../../i18n';
import { chipText, devicesApi, deviceNotices, stateSentence, type Device, type DevicesApi, type DeviceLevel } from '../../lib/devices';
import { DEVICE_NAMES_CHANGED } from '../../lib/deviceNames';
import { errorSentence } from '../../lib/sayError';
import { DeviceActivity } from './DeviceActivity';
import { DeviceNotices } from './DeviceNotices';
import { DeviceRoute } from './DeviceRoute';
import '../../styles/devices.css';

export function DevicePage({ device, api = devicesApi, onBack, onRetry }: { device: Device; api?: DevicesApi; onBack: () => void; onRetry?: () => void }) {
  const t = useT();
  const [name, setName] = useState(device.name);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const run = (p: Promise<unknown>) => p.then(() => setError(null)).catch((e: unknown) => setError(errorSentence(e)));
  const chip = chipText(device);
  const notices = deviceNotices(device);
  return (
    <section className="dev-page" data-testid="device-page" aria-label={device.name}>
      <button type="button" className="dev-btn is-plain" onClick={onBack} data-testid="device-back">
        ‹ {t('devices.back')}
      </button>
      <h3>{device.name}</h3>
      <p className="dev-note">
        <span className={`dev-dot${device.state === 'online' ? ' is-up' : ''}`} aria-hidden="true" /> {stateSentence(device)}
        {chip && (
          <span className="dev-chip" data-testid="route-chip">
            {chip}
          </span>
        )}
      </p>
      <DeviceNotices notices={notices.filter((n) => n.kind !== 'state')} />
      {onRetry && notices.some((n) => n.retry) && (
        <button type="button" className="dev-btn" onClick={onRetry} data-testid="try-again">
          {t('devices.tryAgain')}
        </button>
      )}
      <div className="dev-row">
        <label className="dev-field dev-grow">
          <span>{t('devices.name')}</span>
          <input type="text" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} data-testid="device-name" />
        </label>
        <button type="button" className="dev-btn" disabled={name.trim() === '' || name.trim() === device.name} onClick={() => void run(api.rename(device.node, name.trim()).then(() => window.dispatchEvent(new Event(DEVICE_NAMES_CHANGED))))}>
          {t('devices.saveName')}
        </button>
      </div>
      <h4>{t('devices.let')}</h4>
      <label className="dev-opt dev-switch">
        <input type="checkbox" role="switch" checked={device.lets_run} onChange={(e) => void run(api.setPermission(device.node, e.target.checked, device.level))} data-testid="perm-agents" />
        <span>
          <b>{t('devices.perm.agents')}</b>
          <small>{t('devices.perm.agentsHelp')}</small>
        </span>
      </label>
      {device.lets_run && (
        <div className="dev-levels" role="radiogroup" aria-label={t('devices.level')}>
          {(['watch', 'full'] as DeviceLevel[]).map((level) => (
            <label key={level} className="dev-opt">
              <input type="radio" name="dev-level" checked={device.level === level} onChange={() => void run(api.setPermission(device.node, true, level))} data-testid={`level-${level}`} />
              <span>{level === 'watch' ? t('devices.level.watch') : t('devices.level.full')}</span>
            </label>
          ))}
        </div>
      )}
      <DeviceRoute device={device} api={api} run={run} />
      <p className="dev-note">{t('devices.loginsStay')}</p>
      <DeviceActivity device={device} api={api} />
      {error && (
        <p className="dev-error" role="alert">
          {error}
        </p>
      )}
      {confirmRemove ? (
        <div className="dev-confirm" role="alertdialog">
          <p>{t('devices.removeConfirm', { name: device.name })}</p>
          <div className="dev-actions">
            <button type="button" className="dev-btn" onClick={() => setConfirmRemove(false)}>
              {t('devices.cancel')}
            </button>
            <button type="button" className="dev-btn" data-testid="remove-yes" onClick={() => void run(api.remove(device.node)).then(onBack)}>
              {t('devices.removeYes')}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="dev-btn" onClick={() => setConfirmRemove(true)} data-testid="remove-device">
          {t('devices.remove')}
        </button>
      )}
    </section>
  );
}
