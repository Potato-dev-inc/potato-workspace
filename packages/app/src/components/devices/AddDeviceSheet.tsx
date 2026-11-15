// "Add a device": nearby (not available yet), with a code, far away (a pairing link), over SSH (later).
import { useState } from 'react';
import { useT } from '../../i18n';
import { devicesApi, type DevicesApi, type DevicesView } from '../../lib/devices';
import { errorSentence } from '../../lib/sayError';
import { FarAwayTab } from './FarAwayTab';
import '../../styles/devices.css';

type Tab = 'nearby' | 'code' | 'far' | 'ssh';

export function AddDeviceSheet({
  view,
  api = devicesApi,
  onClose,
  onPaired,
}: {
  view: DevicesView | null;
  api?: DevicesApi;
  onClose: () => void;
  /** The pairing finished: both people said yes. */
  onPaired?: () => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('code');
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const join = () => {
    setBusy(true);
    setError(null);
    api
      .join(address.trim(), code.trim())
      .then(() => {
        onPaired?.();
        onClose();
      })
      .catch((e: unknown) => {
        setError(errorSentence(e));
        setBusy(false);
      });
  };
  const tabs: { id: Tab; label: string; soon?: boolean }[] = [
    { id: 'nearby', label: t('devices.nearby') },
    { id: 'code', label: t('devices.withCode') },
    { id: 'far', label: t('devices.farAway') },
    { id: 'ssh', label: t('devices.overSsh'), soon: true },
  ];
  return (
    <div className="dev-scrim" data-testid="add-device-sheet">
      <div className="dev-sheet" role="dialog" aria-label={t('devices.add')}>
        <h2>{t('devices.add')}</h2>
        <div className="dev-tabs" role="tablist">
          {tabs.map((x) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={tab === x.id}
              disabled={x.soon}
              title={x.soon ? t('devices.comingSoon') : undefined}
              className={`dev-tab${tab === x.id ? ' is-on' : ''}`}
              data-testid={`add-tab-${x.id}`}
              onClick={() => setTab(x.id)}
            >
              {x.label}
              {x.soon && <small> · {t('devices.comingSoon')}</small>}
            </button>
          ))}
        </div>
        {tab === 'nearby' && (
          <p className="dev-note" data-testid="nearby-none">
            {t('devices.nearbyNone')}
          </p>
        )}
        {tab === 'code' && (
          <div className="dev-form">
            <p className="dev-note">{t('devices.joinHelp')}</p>
            <label className="dev-field">
              <span>{t('devices.addressLabel')}</span>
              <input type="text" value={address} placeholder={t('devices.addressPlaceholder')} onChange={(e) => setAddress(e.target.value)} data-testid="join-address" />
            </label>
            <label className="dev-field">
              <span>{t('devices.codeLabel')}</span>
              <input type="text" value={code} placeholder="4F7Q-9K2M" autoCapitalize="characters" onChange={(e) => setCode(e.target.value)} data-testid="join-code" />
            </label>
            {busy && view?.joining && <p className="dev-note">{view.joining}</p>}
            {error && (
              <p className="dev-error" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
        {tab === 'far' && (
          <FarAwayTab
            view={view}
            api={api}
            onJoined={() => {
              onPaired?.();
              onClose();
            }}
          />
        )}
        <div className="dev-actions">
          <button type="button" className="dev-btn" onClick={onClose}>
            {t('devices.cancel')}
          </button>
          {tab === 'code' && (
            <button type="button" className="dev-btn is-primary" disabled={busy || address.trim() === '' || code.trim() === ''} onClick={join} data-testid="join-go">
              {busy ? t('devices.joining') : t('devices.join')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
