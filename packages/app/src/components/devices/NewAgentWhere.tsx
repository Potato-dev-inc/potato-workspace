// "Where" in New agent: a pill (This PC, a Linux distro of this PC, a paired device, or an SSH machine) over the usual New agent
// body. While a paired device is picked, the body is still the usual New agent page: only its data is the device's own (its
// installed agents, models and recent projects, from the far PC's `/pclink/agents` and `/pclink/projects`; `lib/runtime/remoteNewAgent.ts`), and
// starting goes through its `/pclink/agents/start` (the far PC's "Can work on this PC" switch decides). The one visible change is a small "on <device>" label. A device that is offline, or does not let this PC
// in, is listed but cannot be picked. A Linux distro or an SSH machine gets a small body of its own (an agent, a folder, one
// button) that opens a terminal there; chats are not offered over SSH.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import { cannotPickWhy, devicesApi, pcStatus, runtimesOf, type Device, type DevicesApi, type DevicesView } from '../../lib/devices';
import { makeRemoteClient } from '../../lib/runtime/remote';
import { useFarLevel } from '../../lib/runtime/farLevel';
import { atLeast, PcLinkError } from '../../lib/runtime/pclink';
import { sshApi, type SshApi, type SshHost } from '../../lib/ssh';
import { spawnPaneInLinux, tauriWslApi, wslPlacesGet, type WslApi } from '../../lib/wsl';
import { suggestion, useRoomPlaces } from '../../lib/room';
import type { UsageApi } from '../../lib/usage';
import { NewAgentPage, type DevicePicker, type RemoteInfo } from '../cockpit/newagent/NewAgentPage';
import type { ProjectChoice } from '../cockpit/NewAgentMenu';
import { useDeviceProjects } from '../../lib/runtime/deviceProjects';
import { RemoteFolderSheet } from './RemoteFolderSheet';
import { gitStateOf, remotePathOf, useRemoteNewAgent, type RemoteNewAgent, type RemoteStatus } from '../../lib/runtime/remoteNewAgent';
import { SshPanel, WslPanel } from './PlacePanels';
import '../../styles/devices.css';
import { Menu } from '../common/Floating';

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
  /** One plain line for the person (a model that could not be set on the far PC). */
  notify?: (text: string) => void;
  /**
   * The sidebar's quick-start menu has no page of its own. With this, picking a device there remembers it as the place for `pickKey`
   * (a project path, or '' for none) and calls this to open the full New agent page, which then opens on that device.
   */
  onPickPlace?: (node: string) => void;
  pickKey?: string;
}

const STORE_KEY = 'pm.newAgent.where';
/** How long a device that is being checked keeps the state it had. */
const CHECKING_GRACE_MS = 10_000;

const isLocalPlace = (id: string | null): id is string => !!id && (id.startsWith('wsl:') || id.startsWith('ssh:'));
/**
 * A paired device is never remembered across launches (the person would silently be on another PC without knowing). Only the quick-start
 * menu hands one over to the full page, once, through this in-memory note.
 */
let handoff: { key: string; node: string } | null = null;

/** The place last used for a project ('' = no project): only a Linux distro or SSH machine of this PC, or a device just handed over. */
function readPlace(key: string): string | null {
  if (handoff && handoff.key === key) return handoff.node;
  try {
    const all = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, unknown>;
    const v = all[key];
    return typeof v === 'string' && isLocalPlace(v) ? v : null;
  } catch {
    return null;
  }
}
function writePlace(key: string, id: string | null): void {
  if (handoff && handoff.key === key) handoff = null;
  if (id && !isLocalPlace(id)) return;
  try {
    const all = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, unknown>;
    if (id) all[key] = id;
    else delete all[key];
    window.localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    /* the place is simply not remembered */
  }
}

/** On the full New agent page the Linux / SSH body sits in a column of its own, so the form has a margin and its Start button stays on screen. */
function PlacePage({ inline, children }: { inline: boolean; children: ReactNode }) {
  return inline ? (
    <div className="dev-place-page" data-testid="place-page">
      {children}
    </div>
  ) : (
    <>{children}</>
  );
}

/** The app's own sandbox distro reads as "Sandbox"; any other Linux place keeps its name. */
function friendlyPlace(label: string, sandbox: string): string {
  return /^pm-sbx/i.test(label) ? sandbox : label;
}

/** What a picked device hands the page: its sources, and whether they have loaded. */
export interface RemoteSlot {
  remote: RemoteNewAgent;
  /** The far PC lets this PC only watch: the page shows one line instead of Start. */
  agentsOff?: RemoteInfo['agentsOff'];
  status: RemoteStatus;
  /** Why Start is off before anything is typed (the device lets this PC only watch), or null. */
  blocked: string | null;
}

/**
 * `children` is the usual body. As a function it receives the Where pill and draws it itself, inside its own row (the full New
 * agent page puts it before the project pill); as plain nodes the pill sits above them (the sidebar menu).
 * `remember` (a project path, or '' for none) turns on "remember the last place per project".
 */
/** What the full page also gets: the grouped project picker, and the folder a pick in it opens the page on. */
export interface PickerExtras {
  picker: DevicePicker | null;
  startFolder: ProjectChoice | null;
  /** A Linux distro of this PC is picked: the page stays as it is, and an agent starts inside the distro. */
  place: LinuxPlace | null;
}

/** The picked Linux distro: why an agent cannot run in it (null: it can), and how a pane starts in it. */
export interface LinuxPlace {
  distro: string;
  /** A short plain reason, or null when the agent can run in this distro. */
  whyNot: (agentId: string) => string | null;
  /** Starts the agent in the distro (a terminal pane in the folder), opens it, and resolves to the pane id. */
  start: (agentId: string, folder: string | undefined) => Promise<string>;
}

export function NewAgentWhere({ where, children, remember }: { where?: WhereProps; children: ReactNode | ((pill: ReactNode, remote: RemoteSlot | null, extras: PickerExtras) => ReactNode); remember?: string }) {
  const t = useT();
  const api = where?.api ?? devicesApi;
  const sshLayer = where?.ssh ?? sshApi;
  const wslLayer = where?.wsl ?? tauriWslApi;
  /** `null` is This PC; otherwise a device node, `wsl:<distro>` or `ssh:<id>`. */
  const [pick, setPickRaw] = useState<string | null>(() => (remember === undefined ? null : readPlace(remember)));
  const isPlace = (id: string | null) => !!id && (id.startsWith('wsl:') || id.startsWith('ssh:'));
  /** The folder a pick in the grouped project picker opens the (re-made) page on. A pick in the Where pill clears it. */
  const [startFolder, setStartFolder] = useState<ProjectChoice | null>(null);
  const [sheetNode, setSheetNode] = useState<string | null>(null);
  const setPick = (id: string | null) => {
    setPickRaw(id);
    setStartFolder(null);
    if (remember !== undefined) writePlace(remember, id);
  };
  // Another project: its own last place.
  useEffect(() => {
    if (remember !== undefined) setPickRaw(readPlace(remember));
  }, [remember]);
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  const [distros, setDistros] = useState<string[]>([]);
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const wrap = useRef<HTMLDivElement>(null);
  const pillBtn = useRef<HTMLButtonElement>(null);
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
  const [linuxRows, setLinuxRows] = useState<Record<string, string | null> | null>(null);
  const wslDistro = pick?.startsWith('wsl:') ? pick.slice(4) : null;
  // What each agent can do in a Linux distro (a read of the saved facts; it never boots a distro).
  useEffect(() => {
    if (!wslDistro) return;
    let live = true;
    wslPlacesGet(wslLayer).then(
      (rows) => live && setLinuxRows(Object.fromEntries(rows.map((r) => [r.agentId.toLowerCase(), r.whyNot]))),
      () => live && setLinuxRows({}),
    );
    return () => {
      live = false;
    };
  }, [wslDistro, wslLayer]);
  const places = useRoomPlaces(enabled, where?.view ?? null, where?.usage);
  const runtimes = useMemo(() => runtimesOf(where?.view ?? null, distros, hosts), [where?.view, distros, hosts]);
  // A picked device stays picked while it is in the list. Whether it can be reached is read with a grace period for "checking", so the
  // body never flips back and forth with the polls; when it cannot be reached the page says so once and offers This PC.
  const pickedDev = (pick && !isPlace(pick) ? where?.view?.devices.find((d) => d.node === pick) : undefined) ?? null;
  const reach = useRef<{ node: string; ok: boolean; checkingSince: number | null } | null>(null);
  let reachable = false;
  if (pickedDev) {
    const prev = reach.current && reach.current.node === pickedDev.node ? reach.current : null;
    if (pickedDev.state === 'unknown') {
      const since = prev?.checkingSince ?? Date.now();
      reach.current = { node: pickedDev.node, ok: prev ? prev.ok : true, checkingSince: since };
      reachable = reach.current.ok && Date.now() - since < CHECKING_GRACE_MS;
    } else {
      const ok = cannotPickWhy(pickedDev) === null;
      reach.current = { node: pickedDev.node, ok, checkingSince: null };
      reachable = ok;
    }
  }
  const checkingNow = pickedDev?.state === 'unknown';
  useEffect(() => {
    if (!checkingNow) return;
    const id = setTimeout(() => setTick((n) => n + 1), CHECKING_GRACE_MS + 50);
    return () => clearTimeout(id);
  }, [checkingNow, pickedDev?.node]);
  const picked = reachable ? pickedDev : null;
  const unreachable = pickedDev && !reachable ? pickedDev : null;
  const pickedWsl = pick?.startsWith('wsl:') ? runtimes.find((r) => r.id === pick && r.kind === 'wsl') : undefined;
  const pickedSsh = pick?.startsWith('ssh:') ? runtimes.find((r) => r.id === pick && r.kind === 'ssh') : undefined;
  const client = useMemo(() => (picked ? makeRemoteClient(picked.node, api) : null), [picked?.node, api]);
  // What the far PC lets this PC do is the far PC's to say (`GET /pclink/me`). Start works only with its switch on; it can be asked.
  const farLevel = useFarLevel(client, !!picked);
  const levelRef = useRef(farLevel.level);
  levelRef.current = farLevel.level;
  const [askState, setAskState] = useState<{ node: string; state: 'asking' | 'asked' | 'error'; error: string | null } | null>(null);
  // The picked device's answers, as the sources of the usual New agent page. The place stays remembered after a start: the next
  // New agent for this project opens there again.
  const onStartedRef = useRef(where?.onStarted);
  onStartedRef.current = where?.onStarted;
  const far = useRemoteNewAgent(
    picked && client
      ? {
          client,
          node: picked.node,
          deviceName: picked.name,
          canControl: () => levelRef.current === 'full',
          notify: (text) => where?.notify?.(text),
          onStarted: (paneId, chat) => {
            // The agent opens on its PC; the picker goes back to This PC (as it always did).
            setPickRaw(null);
            onStartedRef.current?.(picked, paneId, chat);
          },
        }
      : null,
  );
  // A device that went away ends the pick. The menu itself closes through the shared floating layer.
  useEffect(() => {
    if (pick && !isPlace(pick) && where?.view && !where.view.devices.some((d) => d.node === pick)) setPickRaw(null);
  }, [pick, where?.view]);
  // A PC that has not let this one work on it: Start is replaced by one line, and a button that really asks the person there (a card on
  // that PC; nothing is granted by asking). Honest states: Ask, Asking, Asked and waiting, and what went wrong.
  const mine = askState && picked && askState.node === picked.node ? askState : null;
  const waiting = mine?.state === 'asked' || farLevel.asked;
  const ask = async () => {
    if (!picked || !client) return;
    const node = picked.node;
    setAskState({ node, state: 'asking', error: null });
    try {
      await client.requestFull();
      setAskState({ node, state: 'asked', error: null });
      farLevel.refresh();
    } catch (e) {
      const why = e instanceof PcLinkError ? (e.code === 'TOO_SOON' ? t('newAgent.remote.askTooSoon', { name: picked.name }) : e.status === 403 ? t('newAgent.remote.watchOnly', { name: picked.name }) : e.said ? t('newAgent.remote.askRefused', { name: picked.name, why: e.said }) : t('newAgent.remote.askNoAnswer', { name: picked.name })) : t('newAgent.remote.askNoAnswer', { name: picked.name });
      setAskState({ node, state: 'error', error: why });
    }
  };
  const full = atLeast(farLevel.level, 'full');
  const agentsOff = picked && !full
    ? {
        line: t('newAgent.remote.agentsOff', { name: picked.name }),
        ...(farLevel.level
          ? { ask: { state: waiting ? ('asked' as const) : mine?.state === 'asking' ? ('asking' as const) : mine?.state === 'error' ? ('error' as const) : ('idle' as const), label: t('newAgent.remote.ask', { name: picked.name }), askingLabel: t('newAgent.remote.asking'), askedLine: t('newAgent.remote.asked', { name: picked.name }), error: mine?.state === 'error' ? mine.error : null, onAsk: () => void ask() } }
          : {}),
      }
    : undefined;
  const inline = typeof children === 'function';
  const slot: RemoteSlot | null = picked && far.remote ? { remote: far.remote, agentsOff, status: far.status, blocked: full ? null : t('newAgent.remote.watchOnly', { name: picked.name }) } : null;
  const groupsOf = useDeviceProjects(where?.view ?? null, api, enabled);
  const picker: DevicePicker | null =
    enabled && groupsOf.groups.length > 0
      ? {
          thisName: where!.view!.name,
          groups: groupsOf.groups.map((g) => ({ node: g.node, name: g.name, why: g.why, status: g.status, state: g.state, projects: g.projects })),
          currentNode: picked?.node ?? null,
          onOpen: groupsOf.refresh,
          onPickRemote: (node, p) => {
            setPickRaw(node);
            setStartFolder({ path: remotePathOf(p.id), name: p.name, state: gitStateOf(p.state) });
          },
          onPickLocal: (p) => {
            setPickRaw(null);
            setStartFolder(p);
          },
          onAddRemote: (node) => setSheetNode(node),
        }
      : null;
  const startedHere = (paneId: string) => {
    setPickRaw(null);
    where?.onStartedHere?.(paneId);
  };
  const linuxPlace: LinuxPlace | null =
    pickedWsl && pickedWsl.kind === 'wsl'
      ? {
          distro: pickedWsl.distro,
          whyNot: (agentId) => {
            if (linuxRows === null) return null;
            const key = agentId.toLowerCase();
            return key in linuxRows ? linuxRows[key] : t('devices.wsl.notHere');
          },
          start: async (agentId, folder) => {
            const paneId = await spawnPaneInLinux({ agent_type: agentId, ...(folder ? { cwd: folder } : {}) }, pickedWsl.distro, wslLayer);
            startedHere(paneId);
            return paneId;
          },
        }
      : null;
  const body = (pill: ReactNode): ReactNode => (typeof children === 'function' ? children(pill, slot, { picker, startFolder, place: linuxPlace }) : children);
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
  const here = pickedDev ? pickedDev.name : pickedWsl ? friendlyPlace(pickedWsl.label, t('devices.sandboxLabel')) : pickedSsh ? pickedSsh.label : t('devices.thisPcNamed', { name: where!.view!.name });
  // On the full page the project picker alone chooses the PC: this pill is only "Run in" for this PC's Linux places and SSH machines, and is not
  // drawn at all when there are none, or while another PC's project is picked (that PC's own choices are the page's own).
  const hasPlaces = runtimes.some((r) => r.kind === 'wsl' || r.kind === 'ssh');
  const pillShown = !inline || (hasPlaces && !picked);
  const pill = !pillShown ? null : (
      <div className={`dev-where${inline ? ' dev-where--row' : ''}`} ref={wrap} data-testid="where">
        {!inline && <span>{t('devices.where')}</span>}
        <button ref={pillBtn} type="button" className="dev-where-pill" aria-label={inline ? `${t('devices.runIn')}: ${here}` : undefined} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="where-pill">
          {inline ? `${t('devices.runIn')}: ${here}` : here} ▾
        </button>
        {open && (
          <Menu anchorRef={pillBtn} align="start" className="dev-where-menu" label={inline ? t('devices.runIn') : t('devices.pickWhere')} onClose={() => setOpen(false)}>
            {runtimes.filter((r) => !inline || r.kind !== 'device').map((r) => {
              const pickable = r.kind === 'device' ? r.pickable : true;
              const on = r.kind === 'this' ? pick === null : pick === r.id;
              const place = r.kind === 'wsl' || r.kind === 'ssh';
              const status = r.kind === 'device' ? pcStatus(r.device) : null;
              const label = r.kind === 'this' ? t('devices.thisPcNamed', { name: where!.view!.name }) : r.kind === 'wsl' ? friendlyPlace(r.label, t('devices.sandboxLabel')) : r.label;
              const sub = place ? t('devices.onThisPc') : status ? t(status === 'online' ? 'devices.pcOnline' : status === 'offline' ? 'devices.pcOffline' : 'devices.pcCantConnect') : null;
              return (
                <button
                  key={r.id}
                  type="button"
                  role="menuitem"
                  className={`dev-where-row${on ? ' is-on' : ''}${place ? ' is-place' : ''}${status && status !== 'online' ? ' is-away' : ''}`}
                  disabled={!pickable}
                  title={r.kind === 'device' && r.why ? r.why : undefined}
                  data-testid={`where-${r.id}`}
                  onClick={() => {
                    setOpen(false);
                    // The quick-start menu hands a device over to the full New agent page, which opens on it.
                    if (!inline && r.kind === 'device' && where?.onPickPlace) {
                      handoff = { key: where.pickKey ?? '', node: r.id };
                      where.onPickPlace(r.id);
                      return;
                    }
                    setPick(r.kind === 'this' ? null : r.id);
                  }}
                >
                  <span>{label}</span>
                  {sub && <small>{sub}</small>}
                  {/* Why it cannot be picked: visible text, not only a tooltip on a disabled button. */}
                  {status === 'cant' && r.kind === 'device' && r.why && <small className="dev-where-why" data-testid={`where-why-${r.id}`}>{r.why}</small>}
                </button>
              );
            })}
            {!inline && (
              <button type="button" role="menuitem" className="dev-where-row" data-testid="where-add" onClick={() => (setOpen(false), where!.onAddDevice())}>
                <span>{t('devices.addDots')}</span>
              </button>
            )}
          </Menu>
        )}
      </div>
  );
  const sheetGroup = sheetNode ? groupsOf.groups.find((g) => g.node === sheetNode) : undefined;
  return (
    <>
      {sheetGroup && (
        <FolderSheetHost
          api={api}
          group={sheetGroup}
          onPick={(project) => {
            setSheetNode(null);
            setPickRaw(sheetGroup.node);
            setStartFolder({ path: remotePathOf(project.id), name: project.name, state: gitStateOf(project.state) });
            groupsOf.refresh();
          }}
          onClose={() => setSheetNode(null)}
        />
      )}
      {!inline && pill}
      {!picked && !pickedWsl && !pickedSsh && suggest}
      {unreachable ? (
        <div className="dev-note dev-unreachable" role="status" data-testid="where-unreachable">
          <span>{t('newAgent.remote.unreachable', { name: unreachable.name })}</span>{' '}
          <button type="button" className="ck-na-link" data-testid="where-use-this-pc" onClick={() => setPick(null)}>
            {t('newAgent.remote.useThisPc')}
          </button>
        </div>
      ) : picked && slot ? (
        <>
          {slot.status === 'failed' && (
            <p className="dev-note" role="alert" data-testid="where-load-failed">
              {t('newAgent.remote.noAnswer', { name: slot.remote.deviceName })}{' '}
              <button type="button" className="ck-na-link" onClick={far.retry}>
                {t('phone.nc.tryAgain')}
              </button>
            </p>
          )}
          {inline ? (
            body(pill)
          ) : (
            // The sidebar's quick-start menu has no page of its own: the same New agent page, held in the menu.
            <div className="dev-menu-page" data-testid="where-body">
              <NewAgentPage
                key={slot.remote.node}
                agents={slot.remote.agents}
                panes={[]}
                needs={[]}
                api={slot.remote.api}
                addonApi={slot.remote.addonApi}
                modelApi={slot.remote.modelApi}
                defaultsApi={slot.remote.defaultsApi}
                rulesApi={slot.remote.rulesApi}
                onStart={slot.remote.onStart}
                onOpenPane={() => {}}
                remote={{ deviceName: slot.remote.deviceName, terminals: slot.remote.terminals, blocked: slot.blocked, onWarm: slot.remote.warm, agentsOff }}
              />
            </div>
          )}
        </>
      ) : pickedWsl && pickedWsl.kind === 'wsl' && !inline ? (
        <PlacePage inline={inline}>
          <WslPanel key={pickedWsl.id} distro={pickedWsl.distro} api={wslLayer} onStarted={startedHere} />
        </PlacePage>
      ) : pickedSsh && pickedSsh.kind === 'ssh' ? (
        <PlacePage inline={inline}>
          <SshPanel key={pickedSsh.id} leading={inline ? pill : null} host={pickedSsh.host} api={sshLayer} onStarted={startedHere} />
        </PlacePage>
      ) : (
        body(pill)
      )}
    </>
  );
}

/** The "Open a folder on <PC>" sheet, with what that PC lets this PC do read once (it decides whether Browse folders is offered). */
function FolderSheetHost({ api, group, onPick, onClose }: { api: Pick<DevicesApi, 'request'>; group: { node: string; name: string; projects: { id: string; name: string; state: string }[] }; onPick: (p: { id: string; name: string; state: string }) => void; onClose: () => void }) {
  const client = useMemo(() => makeRemoteClient(group.node, api), [group.node, api]);
  const far = useFarLevel(client, true);
  return <RemoteFolderSheet name={group.name} client={client} projects={group.projects} level={far.level} onPick={onPick} onClose={onClose} />;
}
