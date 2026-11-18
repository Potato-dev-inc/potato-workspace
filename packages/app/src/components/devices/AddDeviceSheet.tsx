// "Add a PC": make a link on one PC, paste it on the other, pick the number that is on both screens. The PCs meet through
// the maker's own relay, so nobody types an address or a code. The older ways (a code on the same network, an SSH
// login) stay one step away under "More ways to add".
import { useState } from 'react';
import { useT } from '../../i18n';
import { devicesApi, type DevicesApi, type DevicesView } from '../../lib/devices';
import { errorSentence } from '../../lib/sayError';
import { FarAwayTab } from './FarAwayTab';
import { SshForm } from './SshForm';
import type { SshApi } from '../../lib/ssh';
import '../../styles/devices.css';

type Tab = 'far' | 'code' | 'ssh';

export function AddDeviceSheet({
  view,
  api = devicesApi,
  ssh,
  onClose,
  onPaired,
  onShowCode,
}: {
  view: DevicesView | null;
  api?: DevicesApi;
  /** The SSH command layer (tests give a fake). */
  ssh?: SshApi;
  onClose: () => void;
  /** The pairing finished: both people said yes. */
  onPaired?: () => void;
  /** "Show a code on this PC instead": the same-network way, where this PC is the one that shows the code. */
  onShowCode?: () => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('far');
  const [more, setMore] = useState(false);
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
  const finish = () => {
    onPaired?.();
    onClose();
  };
  const others: { id: Tab; label: string }[] = [
    { id: 'far', label: t('devices.addPc.link') },
    { id: 'code', label: t('devices.addPc.sameNetwork') },
    { id: 'ssh', label: t('devices.overSsh') },
  ];
  return (
    <div className="dev-scrim" data-testid="add-device-sheet">
      <div className="dev-sheet" role="dialog" aria-label={t('devices.addPc.title')}>
        <h2>{t('devices.addPc.title')}</h2>
        {tab === 'far' && <FarAwayTab view={view} api={api} onJoined={finish} />}
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
        {tab === 'ssh' && <SshForm api={ssh} onCancel={onClose} onSaved={finish} />}
        <details className="dev-more" open={more} onToggle={(e) => setMore(e.currentTarget.open)} data-testid="add-more">
          <summary>{t('devices.moreWays')}</summary>
          <div className="dev-tabs" role="tablist">
            {others.map((x) => (
              <button
                key={x.id}
                type="button"
                role="tab"
                aria-selected={tab === x.id}
                className={`dev-tab${tab === x.id ? ' is-on' : ''}`}
                data-testid={`add-tab-${x.id}`}
                onClick={() => setTab(x.id)}
              >
                {x.label}
              </button>
            ))}
          </div>
        </details>
        {tab !== 'ssh' && (
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
        )}
        {tab === 'code' && onShowCode && (
          <p className="dev-note">
            <button type="button" className="dev-btn" onClick={onShowCode} data-testid="add-show-code">
              {t('devices.showCode')}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
