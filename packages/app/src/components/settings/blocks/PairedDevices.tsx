// Settings › Phone › Devices: every paired phone, what it may do (one switch per ability), when it
// signs out if unused, and Revoke. The bridge enforces the abilities on every request.
import { errorSentence } from '../../../lib/sayError';
import { t, useT } from '../../../i18n';
import { DEVICE_CAPS, type DeviceCap, type PairedDeviceInfo } from '@potato-workspace/shared';
import { useCallback, useEffect, useState } from 'react';
import { tauri } from '../../../lib/tauri';
import { DEVICES_CHANGED_EVENT } from '../../MobilePairingPanel';
import { Switch } from '../controls';
import { Btn, Note } from '../settings-ui';


/** The words for each ability (UX-PHASE1 §0.3: Watch · Answer · Start tasks · Use the terminal). */
export const ABILITIES: { cap: DeviceCap; label: string; hint: string }[] = [
  { cap: 'watch', label: 'Watch', hint: 'See agents and their terminals' },
  { cap: 'answer', label: 'Answer', hint: 'Allow, deny and answer questions' },
  { cap: 'type', label: 'Use the terminal', hint: 'Type into a live terminal' },
  { cap: 'control', label: 'Start tasks', hint: 'Start and close agents, run commands, change settings' },
];

/** A device from an app older than caps has every ability. */
export function deviceCaps(device: PairedDeviceInfo): DeviceCap[] {
  return device.caps ?? [...DEVICE_CAPS];
}

function days(secs: number | undefined): number {
  return Math.round((secs ?? 30 * 24 * 60 * 60) / (24 * 60 * 60));
}

/** "Active · expires if unused for 30 days" or the signed-out line. */
export function expiryLine(device: PairedDeviceInfo): string {
  const window = days(device.idle_expiry_secs);
  if (device.expired) return t('phone.device.signedOut', { days: window });
  return t('phone.device.active', { days: window });
}

function DeviceRow({
  device,
  onChange,
  onRevoke,
  busy,
}: {
  device: PairedDeviceInfo;
  onChange: (caps: DeviceCap[]) => void;
  onRevoke: () => void;
  busy: boolean;
}) {
  const t = useT();
  const caps = deviceCaps(device);
  const toggle = (cap: DeviceCap, on: boolean) =>
    onChange(DEVICE_CAPS.filter((c) => (c === cap ? on : caps.includes(c))));
  return (
    <li className="st-device" data-expired={device.expired ? 'true' : undefined} aria-label={device.name}>
      <div className="st-device-head">
        <div className="st-label">
          <span>{device.name}</span>
          <small>{expiryLine(device)}</small>
        </div>
        <Btn small onClick={onRevoke} disabled={busy}>
          {device.expired ? t('settings.remove') : t('phone.device.revoke')}
        </Btn>
      </div>
      {!device.expired && (
        <ul className="st-abilities" aria-label={t('phone.device.canDo', { name: device.name })}>
          {ABILITIES.map(({ cap }) => (
            <li key={cap} className="st-ability">
              <div className="st-label">
                <span>{t(`phone.ability.${cap}.label`)}</span>
                <small>{t(`phone.ability.${cap}.hint`)}</small>
              </div>
              <Switch
                checked={caps.includes(cap)}
                onChange={(on) => toggle(cap, on)}
                label={`${device.name}: ${t(`phone.ability.${cap}.label`)}`}
                disabled={busy}
              />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function PairedDevices() {
  const t = useT();
  const [devices, setDevices] = useState<PairedDeviceInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setDevices(await tauri.listPairedMobileDevices());
  }, []);

  useEffect(() => {
    void refresh().catch(() => undefined);
    const onChanged = () => void refresh().catch(() => undefined);
    window.addEventListener(DEVICES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(DEVICES_CHANGED_EVENT, onChanged);
  }, [refresh]);

  const run = async (id: string, action: () => Promise<unknown>) => {
    setErr(null);
    setBusy(id);
    try {
      await action();
      await refresh();
      window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT));
    } catch (e) {
      setErr(t('settings.notSaved', { reason: errorSentence(e) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="st-row is-block" data-testid="paired-devices">
      <div className="st-label">
        <span>{t('settings.row.paired-devices.label')}</span>
        <small>{t('phone.devices.hint')}</small>
      </div>
      <div className="st-body">
        {devices.length === 0 ? (
          <p className="st-note">{t('phone.devices.none')}</p>
        ) : (
          <ul className="st-devices">
            {devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                busy={busy === device.id}
                onChange={(caps) => void run(device.id, () => tauri.setPairedMobileDeviceCaps(device.id, caps))}
                onRevoke={() => void run(device.id, () => tauri.revokePairedMobileDevice(device.id))}
              />
            ))}
          </ul>
        )}
        {err && <Note role="alert">{err}</Note>}
      </div>
    </div>
  );
}
