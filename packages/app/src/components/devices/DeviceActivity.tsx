// "Device activity" for one device: what it did on this PC and what this PC did on it, newest first. One line each,
// never a prompt or a file. The names are the device's own (text only). Read again whenever the device changes.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { activityLine, devicesApi, sortActivity, type ActivityEntry, type Device, type DevicesApi } from '../../lib/devices';
import '../../styles/devices.css';

export function DeviceActivity({ device, api = devicesApi }: { device: Device; api?: DevicesApi }) {
  const t = useT();
  const [list, setList] = useState<ActivityEntry[]>([]);
  useEffect(() => {
    let live = true;
    api
      .activity(device.node)
      .then((rows) => live && setList(sortActivity(rows)))
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [api, device]);
  return (
    <>
      <h4>{t('devices.activity')}</h4>
      {list.length === 0 ? (
        <p className="dev-note" data-testid="activity-none">
          {t('devices.activityNone')}
        </p>
      ) : (
        <ul className="dev-activity" data-testid="device-activity">
          {list.map((e, i) => (
            <li key={`${e.at}:${e.kind}:${e.dir}:${i}`} data-dir={e.dir}>
              {activityLine(e)}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
