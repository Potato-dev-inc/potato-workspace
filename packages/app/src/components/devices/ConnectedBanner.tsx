// The far side's thin banner: another device is using this PC right now ("Desk-PC is connected · Full control") with
// Disconnect, which turns that device's switch off and closes its link at once. Draws nothing while nobody is connected
// or the Labs switch is off. The name came from another device: text only.
import { useT } from '../../i18n';
import { clipText, devicesApi, type DevicesApi, type DevicesView } from '../../lib/devices';
import { errorSentence } from '../../lib/sayError';
import { useState } from 'react';
import '../../styles/devices.css';

export function ConnectedBanner({ view, api = devicesApi, onDone }: { view: DevicesView | null; api?: DevicesApi; onDone?: () => void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  if (!view?.enabled) return null;
  const who = view.devices.filter((d) => d.connected && d.lets_run);
  if (who.length === 0) return null;
  return (
    <div className="dev-connected-wrap" data-testid="connected-banner">
      {who.map((d) => (
        <div key={d.node} className="dev-connected" role="status">
          <span className="dev-dot is-up" aria-hidden="true" />
          <span className="dev-grow">{t('devices.connected', { name: clipText(d.name, 40), level: d.level === 'full' ? t('devices.level.full') : t('devices.level.watch') })}</span>
          <button
            type="button"
            className="dev-btn"
            data-testid={`disconnect-${d.node}`}
            onClick={() =>
              api
                .disconnect(d.node)
                .then(() => {
                  setError(null);
                  onDone?.();
                })
                .catch((e: unknown) => setError(errorSentence(e)))
            }
          >
            {t('devices.disconnect')}
          </button>
        </div>
      ))}
      {error && (
        <p className="dev-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
