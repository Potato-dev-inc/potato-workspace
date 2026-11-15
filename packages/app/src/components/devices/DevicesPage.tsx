// Settings > Devices: the paired devices, Add a device, Show a code, the route setting. Everything draws nothing
// while the Labs switch is off. The words are plain: "device" and "Where", never "runtime".
// A device that was just paired (or one the other PC refuses) is not a dead end: its row says what it may do right now and
// offers one button to its own rights choice, and the backend's "nothing is shared yet" line gives way to that next step.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { chipText, devicesApi, nextStepLine, stateSentence, stateWord, type DevicesApi } from '../../lib/devices';
import { EmptyState } from '../common/EmptyState';
import { onOpenDevice, takePendingDevice } from '../../lib/openDevice';
import { AddDeviceSheet } from './AddDeviceSheet';
import { DeviceNextStep } from './DeviceNextStep';
import { DevicePage } from './DevicePage';
import { PairedDevices } from '../settings/blocks/PairedDevices';
import { PairConfirm } from './PairConfirm';
import { RouteSetting } from './RouteSetting';
import { ShowCodeSheet } from './ShowCodeSheet';
import { SshMachines } from './SshMachines';
import type { SshApi } from '../../lib/ssh';
import { useDevices } from './useDevices';
import '../../styles/devices.css';

export function DevicesPage({ api = devicesApi, ssh, onSaved, onOpenPhone, variant = 'settings' }: { api?: DevicesApi; /** The SSH command layer (tests give a fake). */ ssh?: SshApi; onSaved?: () => void; /** "Pair a phone": opens the phone pairing row in Settings. */ onOpenPhone?: () => void; /** `connect`: the Connect page's My PCs tab. What is connected comes first, then the buttons; phones have their own tab. */ variant?: 'settings' | 'connect' }) {
  const t = useT();
  const { view, enabled, refresh } = useDevices(api);
  const [sheet, setSheet] = useState<'add' | 'show' | null>(null);
  // "Open that device" (a lend screen naming a switch on this PC): land on its page, not on the list.
  const [selected, setSelected] = useState<string | null>(takePendingDevice);
  /** The device whose rights choice "Choose what it may do" asked for. */
  const [rightsFor, setRightsFor] = useState<string | null>(null);
  /** The device this visit paired: its next step replaces the backend's "nothing is shared yet" line. */
  const [justPaired, setJustPaired] = useState<string | null>(null);
  const seenNodes = useRef<ReadonlySet<string> | null>(null);
  const [sshSaved, setSshSaved] = useState(0);
  useEffect(() => onOpenDevice((node) => {
    takePendingDevice();
    setSelected(node);
  }), []);
  // One stable object: the screens below start their reads from `api`, so a new one each render would restart them.
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const deviceApi = useMemo<DevicesApi>(() => {
    const saved = (v: unknown) => {
      onSavedRef.current?.();
      refresh();
      return v;
    };
    return {
      ...api,
      setPermission: (...args) => api.setPermission(...args).then(saved) as ReturnType<DevicesApi['setPermission']>,
      rename: (...args) => api.rename(...args).then(saved) as ReturnType<DevicesApi['rename']>,
      remove: (node) => api.remove(node).then(saved) as ReturnType<DevicesApi['remove']>,
      setFiles: (...args) => api.setFiles(...args).then(saved) as ReturnType<DevicesApi['setFiles']>,
      setWeb: (...args) => api.setWeb(...args).then(saved) as ReturnType<DevicesApi['setWeb']>,
      setAgentsSend: (...args) => api.setAgentsSend(...args).then(saved) as ReturnType<DevicesApi['setAgentsSend']>,
      setLend: (...args) => api.setLend(...args).then(saved) as ReturnType<DevicesApi['setLend']>,
      setDeviceRoute: (...args) => api.setDeviceRoute(...args).then(saved) as ReturnType<DevicesApi['setDeviceRoute']>,
    };
  }, [api, refresh]);
  // A device that appeared while this page was open is the one just paired: its own next step replaces the pairing line.
  useEffect(() => {
    if (!view) return;
    const nodes = view.devices.map((d) => d.node);
    const before = seenNodes.current;
    seenNodes.current = new Set(nodes);
    if (!before) return;
    const added = nodes.filter((n) => !before.has(n));
    if (added.length > 0) setJustPaired(added[added.length - 1]!);
  }, [view]);
  if (!enabled || !view) return null;
  const saved = (v: unknown) => {
    onSaved?.();
    refresh();
    return v;
  };
  const device = selected ? view.devices.find((d) => d.node === selected) : undefined;
  const justPairedDevice = justPaired ? view.devices.find((d) => d.node === justPaired) : undefined;
  /** The row's button opens that device's page at its rights choice. */
  const openRights = (node: string) => {
    setRightsFor(node);
    setSelected(node);
  };
  const inConnect = variant === 'connect';
  const buttons = (
    <div className="dev-row">
      <button type="button" className="dev-btn is-primary" onClick={() => setSheet('add')} data-testid="add-device">
        {t('devices.add')}
      </button>
      <button type="button" className="dev-btn" onClick={() => setSheet('show')} data-testid="show-code">
        {t('devices.showCode')}
      </button>
    </div>
  );
  return (
    <section className="dev-page" data-testid="devices-page" aria-label={t('devices.title')}>
      {view.pending && <PairConfirm pending={view.pending} api={api} />}
      {device ? (
        <DevicePage device={device} api={deviceApi} onBack={() => (setSelected(null), setRightsFor(null))} onRetry={refresh} focusRights={rightsFor === device.node} />
      ) : (
        <>
          {!inConnect && <p className="dev-note">{t('devices.blurb')}</p>}
          {view.tampered && (
            <p className="dev-error" role="alert">
              {t('devices.tampered')}
            </p>
          )}
          {justPairedDevice ? (
            <p className="dev-note" data-testid="devices-message">
              {t('devices.paired', { name: justPairedDevice.name })}
            </p>
          ) : (
            view.message && (
              <p className="dev-note" data-testid="devices-message">
                {view.message}
              </p>
            )
          )}
          {!inConnect && buttons}
          <h4>{t('devices.list')}</h4>
          {view.devices.length === 0 ? (
            <EmptyState
              testId="devices-empty"
              title={t('devices.emptyTitle')}
              line={t('devices.emptyLine')}
              action={{ label: t('devices.emptyAction'), onClick: () => setSheet('add') }}
            />
          ) : (
            <ul className="dev-list">
              {view.devices.map((d) => {
                const word = stateWord(d);
                const chip = chipText(d);
                const next = nextStepLine(d);
                return (
                  <li key={d.node}>
                    <button type="button" className="dev-item" onClick={() => setSelected(d.node)} data-testid={`device-${d.node}`}>
                      <span className={`dev-dot${d.state === 'online' ? ' is-up' : ''}`} aria-hidden="true" />
                      <span className="dev-grow">
                        <b>{d.name}</b>
                        <small>{stateSentence(d)}</small>
                      </span>
                      {chip && <span className="dev-chip">{chip}</span>}
                      {word && <span className="dev-word">{word}</span>}
                    </button>
                    {next && <DeviceNextStep device={d} line={next} onChoose={() => openRights(d.node)} />}
                  </li>
                );
              })}
            </ul>
          )}
          {inConnect && buttons}
          <SshMachines api={ssh} refreshKey={sshSaved} />
          <RouteSetting value={view.route_pref} ownReady={view.own_route_ready} onChange={(pref) => void api.setRoute(pref).then(saved)} />
          {!inConnect && (
            <>
              <h4>{t('devices.phones')}</h4>
              <p className="dev-note">{t('devices.phonesBlurb')}</p>
              <div data-testid="phones-section">
                <PairedDevices />
              </div>
            </>
          )}
          {!inConnect && onOpenPhone && (
            <div className="dev-row">
              <button type="button" className="dev-btn" onClick={onOpenPhone} data-testid="pair-phone">
                {t('devices.pairPhone')}
              </button>
            </div>
          )}
        </>
      )}
      {sheet === 'add' && <AddDeviceSheet
          view={view}
          api={api}
          ssh={ssh}
          onClose={() => setSheet(null)}
          onPaired={() => {
            setSshSaved((n) => n + 1);
            refresh();
          }}
        />}
      {sheet === 'show' && <ShowCodeSheet view={view} api={api} onClose={() => setSheet(null)} />}
    </section>
  );
}
