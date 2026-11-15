// The plain lines about a device that is not fine: its state, an agent signed out there, a prompt only a person at that
// device can answer. The lines come from `deviceNotices`; texts that came from the device are shown as text only.
import { useT } from '../../i18n';
import type { DeviceNotice } from '../../lib/devices';
import '../../styles/devices.css';

export function DeviceNotices({ notices, onRetry, className = 'dev-notices' }: { notices: DeviceNotice[]; onRetry?: () => void; className?: string }) {
  const t = useT();
  if (notices.length === 0) return null;
  return (
    <ul className={className} data-testid="device-notices">
      {notices.map((n) => (
        <li key={n.id} className={`dev-notice is-${n.kind}`} data-notice={n.kind}>
          <span>{n.text}</span>
          {n.hint && <small>{n.hint}</small>}
          {n.retry && onRetry && (
            <button type="button" className="dev-btn is-plain" onClick={onRetry} data-testid="try-again">
              {t('devices.tryAgain')}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
