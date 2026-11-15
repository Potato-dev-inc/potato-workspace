// The next step for a device the person cannot use yet (a freshly paired PC, or one the far side refuses): one short line
// about what it may do right now, and one button to that device's own rights choice. The switches stay on the device's
// page; nothing is turned on from here, and the words name the right instead of a dead end.
import { useT } from '../../i18n';
import type { Device } from '../../lib/devices';
import '../../styles/devices.css';

export function DeviceNextStep({ device, line, onChoose }: { device: Device; line: string; onChoose: () => void }) {
  const t = useT();
  return (
    <div className="dev-next" data-testid={`device-next-${device.node}`}>
      <span className="dev-grow">{line}</span>
      <button type="button" className="dev-btn" onClick={onChoose} data-testid={`device-choose-${device.node}`}>
        {t('devices.next.choose')}
      </button>
    </div>
  );
}
