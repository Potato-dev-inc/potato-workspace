// Settings > Advanced > Phone and other devices > "My PCs": what each paired PC may do besides watching and answering. These are the
// switches the Connect page no longer shows (its PC sheet keeps only "Can work on this PC"): browse and copy my files (and which folders),
// borrow my agent sign-ins, my agents sending work to it, and the file transfers. Same commands as before, plain words.
import { useState } from 'react';
import { useT } from '../../../i18n';
import { devicesApi, deviceLabel, type Device, type DevicesApi } from '../../../lib/devices';
import { errorSentence } from '../../../lib/sayError';
import { DeviceFolders } from '../../devices/DeviceFolders';
import { Transfers } from '../../devices/TransferRow';
import { useDevices } from '../../devices/useDevices';
import { Switch } from '../controls';

function PcRow({ device, api, onChanged }: { device: Device; api: DevicesApi; onChanged: () => void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const run = (p: Promise<unknown>) =>
    p
      .then(() => (setError(null), onChanged()))
      .catch((e: unknown) => setError(errorSentence(e)));
  const line = (label: string, hint: string, checked: boolean, testId: string, on: (v: boolean) => Promise<unknown>) => (
    <div className="st-row" data-testid={testId}>
      <div className="st-label">
        <span>{label}</span>
        <small>{hint}</small>
      </div>
      <Switch checked={checked} label={`${deviceLabel(device)}: ${label}`} onChange={(v) => void run(on(v))} />
    </div>
  );
  return (
    <li className="st-device" data-testid={`settings-pc-${device.node}`}>
      <div className="st-device-head">
        <div className="st-label">
          <span>{deviceLabel(device)}</span>
        </div>
      </div>
      {line(t('connect.pc.filesLabel'), t('connect.pc.filesHint'), device.lets_files, 'settings-pc-files', (v) => api.setFiles(device.node, v))}
      {device.lets_files && <DeviceFolders device={device} api={api} />}
      {line(t('connect.pc.lendLabel'), t('connect.pc.lendHint'), device.lets_lend, 'settings-pc-lend', (v) => api.setLend(device.node, v))}
      {line(t('connect.pc.sendLabel'), t('connect.pc.sendHint'), device.agents_may_send, 'settings-pc-send', (v) => api.setAgentsSend(device.node, v))}
      <Transfers api={api} node={device.node} />
      {error && (
        <small className="st-note" role="alert">
          {error}
        </small>
      )}
    </li>
  );
}

export function PhoneDevicesPcs({ api = devicesApi }: { api?: DevicesApi }) {
  const t = useT();
  const { view, enabled, refresh } = useDevices(api);
  if (!enabled || !view) return null;
  return (
    <div data-testid="settings-my-pcs">
      <h4 className="st-subhead">{t('connect.pc.title')}</h4>
      {view.devices.length === 0 ? (
        <p className="st-note">{t('settings.myPcs.none')}</p>
      ) : (
        <ul className="st-devices">
          {view.devices.map((d) => (
            <PcRow key={d.node} device={d} api={api} onChanged={refresh} />
          ))}
        </ul>
      )}
    </div>
  );
}
