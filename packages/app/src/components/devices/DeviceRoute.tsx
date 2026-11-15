// On a device's page: how THIS device connects (the choice of this PC, or its own), and whether it may also reach this
// PC through the person's web address. The far side decides what it allows; these only set this PC's side.
import { useT } from '../../i18n';
import type { Device, DevicesApi, RoutePref } from '../../lib/devices';
import '../../styles/devices.css';

export function DeviceRoute({ device, api, run }: { device: Device; api: DevicesApi; run: (p: Promise<unknown>) => Promise<unknown> }) {
  const t = useT();
  const value = device.route_override ?? 'same';
  return (
    <>
      <label className="dev-field">
        <span>{t('devices.route.device')}</span>
        <select
          className="dev-select"
          value={value}
          data-testid="device-route"
          onChange={(e) => void run(api.setDeviceRoute(device.node, e.target.value === 'same' ? null : (e.target.value as RoutePref)))}
        >
          <option value="same">{t('devices.route.same')}</option>
          <option value="auto">{t('devices.route.auto')}</option>
          <option value="public">{t('devices.route.public')}</option>
          <option value="own">{t('devices.route.own')}</option>
        </select>
      </label>
      {device.route_override === 'own' && !device.web_ready && (
        <p className="dev-note" data-testid="route-no-web">
          {t('devices.route.noWeb', { name: device.name })}
        </p>
      )}
      {device.lets_run && (
        <label className="dev-opt dev-switch">
          <input type="checkbox" role="switch" checked={device.lets_web} onChange={(e) => void run(api.setWeb(device.node, e.target.checked))} data-testid="perm-web" />
          <span>
            <b>{t('devices.web.title')}</b>
            <small>{t('devices.web.help')}</small>
          </span>
        </label>
      )}
    </>
  );
}
