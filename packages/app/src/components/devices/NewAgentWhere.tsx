// "Where" in New agent: a pill (This PC, a Linux distro of this PC, a paired device, or an SSH machine) over the usual New agent
// body. While a paired device is picked, the body is that device's own: its installed agents and its recent projects (the far
// bridge's `GET /phone/new-chat`), and starting goes through the far bridge. A device that is offline, or does not let this PC
// in, is listed but cannot be picked. A Linux distro or an SSH machine gets a small body of its own (an agent, a folder, one
// button) that opens a terminal there; chats are not offered over SSH.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import { cannotPickWhy, devicesApi, runtimesOf, stateSentence, type Device, type DevicesApi, type DevicesView } from '../../lib/devices';
import { makeRemoteClient } from '../../lib/runtime/remote';
import { sshApi, type SshApi, type SshHost } from '../../lib/ssh';
import { tauriWslApi, type WslApi } from '../../lib/wsl';
import { suggestion, useRoomPlaces } from '../../lib/room';
import type { UsageApi } from '../../lib/usage';
import { PhoneNewChat } from '../mobile/PhoneNewChat';
import { DisabledReason } from '../common/DisabledReason';
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
  /** Where this PC's usage comes from (tests give a fake). */
  usage?: UsageApi;
}

const STORE_KEY = 'pm.newAgent.where';

/** The place last used for a project ('' = no project). Nothing when nothing was saved or storage is closed. */
function readPlace(key: string): string | null {
  try {
    const all = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, unknown>;
    const v = all[key];
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}
function writePlace(key: string, id: string | null): void {
  try {
    const all = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, unknown>;
    if (id) all[key] = id;
    else delete all[key];
    window.localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    /* the place is simply not remembered */
  }
}

/**
 * `children` is the usual body. As a function it receives the Where pill and draws it itself, inside its own row (the full New
 * agent page puts it before the project pill); as plain nodes the pill sits above them (the sidebar menu).
 * `remember` (a project path, or '' for none) turns on "remember the last place per project".
 */
export function NewAgentWhere({ where, children, remember }: { where?: WhereProps; children: ReactNode | ((pill: ReactNode) => ReactNode); remember?: string }) {
  const t = useT();
  const api = where?.api ?? devicesApi;
  const sshLayer = where?.ssh ?? sshApi;
  const wslLayer = where?.wsl ?? tauriWslApi;
  /** `null` is This PC; otherwise a device node, `wsl:<distro>` or `ssh:<id>`. */
  const [pick, setPickRaw] = useState<string | null>(() => (remember === undefined ? null : readPlace(remember)));
  const setPick = (id: string | null) => {
    setPickRaw(id);
    if (remember !== undefined) writePlace(remember, id);
  };
  // Another project: its own last place.
  useEffect(() => {
    if (remember !== undefined) setPickRaw(readPlace(remember));
  }, [remember]);
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
  const places = useRoomPlaces(enabled, where?.view ?? null, where?.usage);
  const runtimes = useMemo(() => runtimesOf(where?.view ?? null, distros, hosts), [where?.view, distros, hosts]);
  // A remembered device that is offline now cannot be used: This PC shows, and the memory is kept for next time.
  const picked = where?.view?.devices.find((d) => d.node === pick && cannotPickWhy(d) === null) ?? null;
  const pickedWsl = pick?.startsWith('wsl:') ? runtimes.find((r) => r.id === pick && r.kind === 'wsl') : undefined;
  const pickedSsh = pick?.startsWith('ssh:') ? runtimes.find((r) => r.id === pick && r.kind === 'ssh') : undefined;
  const bridge = useMemo(() => (picked ? makeRemoteClient(picked.node, api) : null), [picked?.node, api]);
  // A closed menu and a click elsewhere end the picker; a device that went away ends the pick.
  useDismissable(open, { inside: [wrap], anchor: wrap, ignore: ['escape'], onDismiss: () => setOpen(false) });
  useEffect(() => {
    if (pick && !pick.startsWith('wsl:') && !pick.startsWith('ssh:') && !where?.view?.devices.some((d) => d.node === pick)) setPickRaw(null);
  }, [pick, where?.view]);
  const inline = typeof children === 'function';
  const body = (pill: ReactNode): ReactNode => (typeof children === 'function' ? children(pill) : children);
  if (!enabled) return <>{body(null)}</>;
  // "More room on Laptop · Use it": only while This PC is picked, for a PC that can be picked now.
  const better = pick === null ? suggestion(places) : null;
  const betterDevice = better ? where?.view?.devices.find((d) => d.node === better.node && cannotPickWhy(d) === null) : undefined;
  const suggest = better && betterDevice ? (
    <p className="ck-room-suggest" data-testid="room-suggest">
      <span>{t('status.room.suggest', { place: betterDevice.name })}</span>
      <button type="button" className="ck-usage-link" data-testid="room-use" onClick={() => setPick(betterDevice.node)}>
        {t('status.room.use')}
      </button>
    </p>
  ) : null;
  const here = picked ? picked.name : pickedWsl ? pickedWsl.label : pickedSsh ? pickedSsh.label : t('devices.thisPc');
  const startedHere = (paneId: string) => {
    setPickRaw(null);
    where?.onStartedHere?.(paneId);
  };
  const pill = (
      <div className={`dev-where${inline ? ' dev-where--row' : ''}`} ref={wrap} data-testid="where">
        {!inline && <span>{t('devices.where')}</span>}
        <button type="button" className="dev-where-pill" aria-label={inline ? `${t('devices.where')}: ${here}` : undefined} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="where-pill">
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
                  data-testid={`where-${r.id}`}
                  onClick={() => {
                    setPick(r.kind === 'this' ? null : r.id);
                    setOpen(false);
                  }}
                >
                  <span>{r.label}</span>
                  <small>{sub}</small>
                  {!pickable && r.kind === 'device' && r.why ? <DisabledReason as="span" reason={t('devices.cannotPick', { why: r.why })} /> : null}
                </button>
              );
            })}
            <button type="button" role="menuitem" className="dev-where-row" data-testid="where-add" onClick={() => (setOpen(false), where!.onAddDevice())}>
              <span>{t('devices.addDots')}</span>
            </button>
          </div>
        )}
      </div>
  );
  return (
    <>
      {!inline && pill}
      {!picked && !pickedWsl && !pickedSsh && suggest}
      {picked && bridge ? (
        // The phone screens are styled under `.ph` (tokens and layout): the wrapper brings them to the desktop page.
        <div className="ph dev-ph-embed" data-testid="where-body">
        <PhoneNewChat
          key={picked.node}
          leading={inline ? pill : null}
          bridge={bridge}
          canControl={picked.level === 'full'}
          onClose={() => setPick(null)}
          onStarted={(paneId, lane) => {
            // The place stays remembered: the next New agent for this project opens there again.
            setPickRaw(null);
            where!.onStarted(picked, paneId, lane === 'chat');
          }}
        />
        </div>
      ) : pickedWsl && pickedWsl.kind === 'wsl' ? (
        <WslPanel key={pickedWsl.id} leading={inline ? pill : null} distro={pickedWsl.distro} api={wslLayer} onStarted={startedHere} />
      ) : pickedSsh && pickedSsh.kind === 'ssh' ? (
        <SshPanel key={pickedSsh.id} leading={inline ? pill : null} host={pickedSsh.host} api={sshLayer} onStarted={startedHere} />
      ) : (
        body(pill)
      )}
    </>
  );
}
