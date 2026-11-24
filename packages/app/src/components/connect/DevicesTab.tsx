// Connect > Devices: "This PC" first (can my phone and my other PCs reach it?), then two separate groups: "My phone" and "My PCs".
// Open on a PC jumps to its section in the sidebar through `onOpenPc`; until the cockpit provides that, the Devices tab
// shows that PC's own page (the one Settings > Devices always had) with a Back button.
import type { Settings } from '@potato-workspace/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import type { DevicesApi } from '../../lib/devices';
import { onOpenDevice, takePendingDevice } from '../../lib/openDevice';
import type { SettingsPatch } from '../../lib/settings';
import { defaultTunnelApi } from '../PairingAddress';
import { DevicePage } from '../devices/DevicePage';
import { useDevices } from '../devices/useDevices';
import type { ConnectApi } from './ConnectPage';
import { PcGroup } from './PcGroup';
import type { LendHandle } from '../lend/useLend';
import { PhoneGroup } from './PhoneGroup';
import { SshGroup } from './SshGroup';
import { ThisPcRow, type ThisPcHandle } from './ThisPc';

export function DevicesTab({
  api,
  settings,
  patch,
  pc,
  active,
  onOpenPc,
  onOpenPane,
  lend,
}: {
  api: ConnectApi;
  settings: Settings | null;
  patch: (p: SettingsPatch) => Promise<void>;
  pc: ThisPcHandle;
  /** The Devices tab is on screen. */
  active: boolean;
  /** The cockpit's way to show a PC's section in the sidebar. Absent: this tab shows the PC's own page. */
  onOpenPc?: (node: string) => boolean | void;
  /** A terminal was opened on an SSH computer: show that pane. */
  onOpenPane?: (paneId: string) => void;
  /** The lend state, shared with the Lending tab. */
  lend?: LendHandle;
}) {
  const t = useT();
  const { view, refresh } = useDevices(api.devices);
  const [selected, setSelected] = useState<string | null>(takePendingDevice);
  useEffect(
    () =>
      onOpenDevice((node) => {
        takePendingDevice();
        setSelected(node);
      }),
    [],
  );
  const onSavedRef = useRef(refresh);
  onSavedRef.current = refresh;
  // One stable object: the page below starts its reads from `api`, so a new one each render would restart them.
  const deviceApi = useMemo<DevicesApi>(() => {
    const d = api.devices;
    const saved = (v: unknown) => (onSavedRef.current(), v);
    return {
      ...d,
      setPermission: (...a) => d.setPermission(...a).then(saved) as ReturnType<DevicesApi['setPermission']>,
      rename: (...a) => d.rename(...a).then(saved) as ReturnType<DevicesApi['rename']>,
      remove: (n) => d.remove(n).then(saved) as ReturnType<DevicesApi['remove']>,
      setFiles: (...a) => d.setFiles(...a).then(saved) as ReturnType<DevicesApi['setFiles']>,
      setWeb: (...a) => d.setWeb(...a).then(saved) as ReturnType<DevicesApi['setWeb']>,
      setAgentsSend: (...a) => d.setAgentsSend(...a).then(saved) as ReturnType<DevicesApi['setAgentsSend']>,
      setLend: (...a) => d.setLend(...a).then(saved) as ReturnType<DevicesApi['setLend']>,
      setDeviceRoute: (...a) => d.setDeviceRoute(...a).then(saved) as ReturnType<DevicesApi['setDeviceRoute']>,
    };
  }, [api.devices]);
  const device = selected ? view?.devices.find((d) => d.node === selected) : undefined;
  if (device) {
    return (
      <div className="cx-page" data-testid="connect-device-page">
        <DevicePage device={device} api={deviceApi} onBack={() => setSelected(null)} onRetry={refresh} hideRoute />
      </div>
    );
  }
  return (
    <div className="cx-page">
      <ThisPcRow pc={pc} name={view?.name || t('connect.thisPc.name')} />
      <PhoneGroup
        tunnel={api.tunnel ?? defaultTunnelApi}
        listPhones={api.listPhones}
        phoneApi={api.phoneApi}
        publicPwaUrl={settings?.public_pwa_url ?? ''}
        devServerPort={settings?.dev_server_port}
        ready={settings !== null}
        active={active}
        waiting={pc.state === 'broken'}
      />
      <PcGroup api={api} settings={settings} patch={patch} onOpenPc={onOpenPc ?? ((node) => setSelected(node))} waiting={pc.state === 'broken'} needsUpdate={pc.needsUpdate} onUpdate={pc.startSetup} lend={lend} />
      <SshGroup api={api.ssh} onOpenPane={onOpenPane} />
    </div>
  );
}
