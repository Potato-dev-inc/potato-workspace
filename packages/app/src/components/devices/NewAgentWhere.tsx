// "Where" in New agent: a pill (This PC, a Linux distro of this PC, a paired device, or an SSH machine) over the usual New agent
// body. While a paired device is picked, the body is that device's own: its installed agents and its recent projects (the far
// bridge's `GET /phone/new-chat`), and starting goes through the far bridge. A device that is offline, or does not let this PC
// in, is listed but cannot be picked. A Linux distro or an SSH machine gets a small body of its own (an agent, a folder, one
// button) that opens a terminal there; chats are not offered over SSH.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import { devicesApi, runtimesOf, stateSentence, type Device, type DevicesApi, type DevicesView } from '../../lib/devices';
import { makeRemoteClient } from '../../lib/runtime/remote';
import { sshApi, type SshApi, type SshHost } from '../../lib/ssh';
import { tauriWslApi, type WslApi } from '../../lib/wsl';
import { PhoneNewChat } from '../mobile/PhoneNewChat';
import { SshPanel, WslPanel } from './PlacePanels';
import '../../styles/devices.css';
import { useDismissable } from '../../hooks/useDismissable';

export interface WhereProps {
  view: DevicesView | null;
  /** "Add a device…": opens Settings > Devices. */
  onAddDevice: () => void;
  /** Something was started on a device: open it. `chat` is false for a terminal. */
  onStarted: (device: Device, paneId: string, chat: boolean) => void;
  /** A terminal was started in a Linux distro of this PC, or on an SSH machine: open that pane. */
  onStartedHere?: (paneId: string) => void;
  api?: DevicesApi;
  /** The SSH and Linux command layers (tests give fakes). */
  ssh?: SshApi;
  wsl?: WslApi;
}

export function NewAgentWhere({ where, children }: { where?: WhereProps; children: ReactNode }) {
  const t = useT();
  const api = where?.api ?? devicesApi;
  const sshLayer = where?.ssh ?? sshApi;
  const wslLayer = where?.wsl ?? tauriWslApi;
  /** `null` is This PC; otherwise a device node, `wsl:<distro>` or `ssh:<id>`. */
  const [pick, setPick] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [distros, setDistros] = useState<string[]>([]);
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const wrap = useRef<HTMLDivElement>(null);
  const enabled = where?.view?.enabled === true;
  // The Linux places and the SSH machines are read when the picker opens (the list of distros never boots one).
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    wslLayer.status(false).then(
      (st) => live && setDistros(st.state === 'ready' ? st.distros.filter((d) => d.version === 2).map((d) => d.name) : []),
      () => {},
    );
    sshLayer.hosts().then(
      (h) => live && setHosts(Array.isArray(h) ? h : []),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [enabled, open, wslLayer, sshLayer]);
  const runtimes = useMemo(() => runtimesOf(where?.view ?? null, distros, hosts), [where?.view, distros, hosts]);
  const picked = where?.view?.devices.find((d) => d.node === pick) ?? null;
  const pickedWsl = pick?.startsWith('wsl:') ? runtimes.find((r) => r.id === pick && r.kind === 'wsl') : undefined;
  const pickedSsh = pick?.startsWith('ssh:') ? runtimes.find((r) => r.id === pick && r.kind === 'ssh') : undefined;
  const bridge = useMemo(() => (picked ? makeRemoteClient(picked.node, api) : null), [picked?.node, api]);
  // A closed menu and a click elsewhere end the picker; a device that went away ends the pick.
  useDismissable(open, { inside: [wrap], anchor: wrap, ignore: ['escape'], onDismiss: () => setOpen(false) });
  useEffect(() => {
    if (pick && !pick.startsWith('wsl:') && !pick.startsWith('ssh:') && !picked) setPick(null);
  }, [pick, picked]);
  if (!enabled) return <>{children}</>;
  const here = picked ? picked.name : pickedWsl ? pickedWsl.label : pickedSsh ? pickedSsh.label : t('devices.thisPc');
  const startedHere = (paneId: string) => {
    setPick(null);
    where?.onStartedHere?.(paneId);
  };
  return (
    <>
      <div className="dev-where" ref={wrap} data-testid="where">
        <span>{t('devices.where')}</span>
        <button type="button" className="dev-where-pill" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="where-pill">
          {here} ▾
        </button>
        {open && (
          <div className="dev-where-menu" role="menu" aria-label={t('devices.pickWhere')}>
            {runtimes.map((r) => {
              const pickable = r.kind === 'device' ? r.pickable : true;
              const on = r.kind === 'this' ? pick === null : pick === r.id;
              const sub = r.kind === 'this' ? where!.view!.name : r.kind === 'device' ? stateSentence(r.device) : r.kind === 'wsl' ? t('devices.wsl.sub') : t('devices.ssh.sub');
              return (
                <button
                  key={r.id}
                  type="button"
                  role="menuitem"
                  className={`dev-where-row${on ? ' is-on' : ''}`}
                  disabled={!pickable}
                  title={r.kind === 'device' && r.why ? t('devices.cannotPick', { why: r.why }) : undefined}
                  data-testid={`where-${r.id}`}
                  onClick={() => {
                    setPick(r.kind === 'this' ? null : r.id);
                    setOpen(false);
                  }}
                >
                  <span>{r.label}</span>
                  <small>{sub}</small>
                </button>
              );
            })}
            <button type="button" role="menuitem" className="dev-where-row" data-testid="where-add" onClick={() => (setOpen(false), where!.onAddDevice())}>
              <span>{t('devices.addDots')}</span>
            </button>
          </div>
        )}
      </div>
      {picked && bridge ? (
        <PhoneNewChat
          key={picked.node}
          bridge={bridge}
          canControl={picked.level === 'full'}
          onClose={() => setPick(null)}
          onStarted={(paneId, lane) => {
            setPick(null);
            where!.onStarted(picked, paneId, lane === 'chat');
          }}
        />
      ) : pickedWsl && pickedWsl.kind === 'wsl' ? (
        <WslPanel key={pickedWsl.id} distro={pickedWsl.distro} api={wslLayer} onStarted={startedHere} />
      ) : pickedSsh && pickedSsh.kind === 'ssh' ? (
        <SshPanel key={pickedSsh.id} host={pickedSsh.host} api={sshLayer} onStarted={startedHere} />
      ) : (
        children
      )}
    </>
  );
}
