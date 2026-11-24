// What a far chat or terminal shows once its PC is back and no longer has it: one plain line and Close (never a blank header).
import { useT } from '../../i18n';
import { clipText, type Device } from '../../lib/devices';
import '../../styles/devices.css';

export function FarGone({ device, chat, onClose }: { device: Device; chat: boolean; onClose: () => void }) {
  const t = useT();
  return (
    <section className="dev-remote" data-testid="far-gone" aria-label={clipText(device.name, 40)}>
      <p className="dev-remote-note" role="status">
        {t(chat ? 'devices.remote.goneChat' : 'devices.remote.goneTerminal', { name: clipText(device.name, 40) })}
      </p>
      <div className="dev-remote-bar">
        <button type="button" className="dev-btn is-plain dev-remote-close" data-testid="far-gone-close" onClick={onClose}>
          {t('sidebar.close')}
        </button>
      </div>
    </section>
  );
}
