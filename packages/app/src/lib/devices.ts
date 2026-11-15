// Devices (Labs `devices_enabled`, off by default): pair another PC that runs Potato Workspace, then run a chat or a
// terminal on it and see it in the sidebar.
//
// The Rust side (src-tauri/src/device_link) holds everything; this file is the typed command surface, the words, and the
// small rules the screens share. A device is "a place an agent runs": `runtimesOf` lists This PC, each paired device
// and the Linux places of this PC for the Where picker. The far device decides what this PC may do (its switch and
// level); the buttons here only hide what would be refused. Anything that comes from a device (its name, its panes,
// their titles) is untrusted text: render it as text only.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { loadSettings } from './settings';

export type RoutePref = 'auto' | 'public' | 'own';
export type DeviceLevel = 'watch' | 'full';
export type DeviceLinkState = 'online' | 'offline' | 'asleep' | 'closed' | 'not_allowed' | 'unknown';
/** The route a live link uses: straight to the device, through the public relay, or through the person's own link. */
export type DevicePath = 'direct' | 'relay' | 'own' | null;

export interface Device {
  /** The device's node id (64 hex characters). */
  node: string;
  name: string;
  added_at: number;
  state: DeviceLinkState;
  path: DevicePath;
  /** Unix seconds. */
  last_seen: number | null;
  /** What THIS PC lets that device do: the switch and the level. Off after pairing. */
  lets_run: boolean;
  level: DeviceLevel;
  /** That device runs an older Potato Workspace: it cannot connect until it is updated. */
  too_old: boolean;
  /** THIS PC lets that device reach it through its web address too. */
  lets_web: boolean;
  /** THIS PC holds a web address and a token for that device, so "Your link" works toward it. */
  web_ready: boolean;
  /** How this device connects when it is not "same as this PC". */
  route_override: RoutePref | null;
  /** Agent ids that are signed out THERE. Untrusted text. */
  signed_out: string[];
  /** Prompts only a person at that device can answer. `what` is untrusted text. */
  needs_person: { pane: string; what: string }[];
  /** That device is using THIS PC right now. */
  connected: boolean;
}

export interface HostingView {
  /** `code` for a code and an address; `link` for a pairing link (a long text for far away). */
  kind: 'code' | 'link';
  code: string;
  address: string;
  link?: string;
  expires_at: number;
}

export type ActivityKind = 'connected' | 'started' | 'typed' | 'messaged' | 'answered' | 'stopped' | 'changed' | 'refused';

/** One line of "Device activity". Never holds prompt text. `in`: that device did it on THIS PC. `out`: this PC did it there. */
export interface ActivityEntry {
  /** Unix seconds. */
  at: number;
  node: string;
  name: string;
  dir: 'in' | 'out';
  kind: ActivityKind;
}

export interface PendingPair {
  id: number;
  role: 'host' | 'joiner';
  name: string;
  code: string;
  expires_at: number;
}

export interface DevicesView {
  enabled: boolean;
  /** This PC's own name. */
  name: string;
  route_pref: RoutePref;
  /** A stable link or tunnel is set up (Settings > Phone), so "My own route" can work. */
  own_route_ready: boolean;
  hosting: HostingView | null;
  pending: PendingPair | null;
  joining: string | null;
  message: string | null;
  locked_until: number | null;
  tampered: boolean;
  devices: Device[];
}

export interface RequestResult {
  status: number;
  body: unknown;
}

export interface DeviceEvent {
  node: string;
  /** Exactly one bridge SSE frame: `event: <name>\ndata: <json>\n\n`. */
  frame: string;
}

export interface ScreenFrame {
  node: string;
  pane_id: string;
  content: string;
}

export interface DevicesApi {
  state: () => Promise<DevicesView>;
  showCode: () => Promise<DevicesView>;
  cancelCode: () => Promise<DevicesView>;
  join: (address: string, code: string) => Promise<DevicesView>;
  pairAnswer: (id: number, allow: boolean) => Promise<DevicesView>;
  rename: (node: string, name: string) => Promise<DevicesView>;
  setPermission: (node: string, on: boolean, level?: DeviceLevel) => Promise<DevicesView>;
  remove: (node: string) => Promise<DevicesView>;
  setRoute: (pref: RoutePref) => Promise<DevicesView>;
  /** Far away: this PC makes a pairing link (valid 10 minutes, works once). It shows in `hosting`. */
  makeLink: () => Promise<DevicesView>;
  joinLink: (link: string) => Promise<DevicesView>;
  /** Device activity (the caller sorts). All devices when `node` is left out. */
  activity: (node?: string) => Promise<ActivityEntry[]>;
  /** "Also allow through my web address": only meaningful while that device may run agents here. */
  setWeb: (node: string, on: boolean) => Promise<DevicesView>;
  /** How one device connects; null follows this PC's choice. */
  setDeviceRoute: (node: string, pref: RoutePref | null) => Promise<DevicesView>;
  /** Turns that device's "run agents here" switch off and closes its link now. */
  disconnect: (node: string) => Promise<DevicesView>;
  /** The live screen of a far terminal: frames arrive as `onScreen` events, the first one right after start. */
  screenStart: (node: string, paneId: string) => Promise<void>;
  screenStop: (node: string, paneId: string) => Promise<void>;
  onScreen: (cb: (e: ScreenFrame) => void) => Promise<UnlistenFn>;
  /** Runs one bridge route on the far device through the PC link. The far device enforces its rights. */
  request: (node: string, method: string, path: string, body?: unknown) => Promise<RequestResult>;
  subscribe: (node: string) => Promise<void>;
  unsubscribe: (node: string) => Promise<void>;
  onChanged: (cb: (view: DevicesView) => void) => Promise<UnlistenFn>;
  onEvent: (cb: (event: DeviceEvent) => void) => Promise<UnlistenFn>;
}

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const noop: UnlistenFn = () => {};

function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error(`Desktop shell required: ${command}`));
  return invoke<T>(command, args);
}

export const devicesApi: DevicesApi = {
  state: () => call('devices_state'),
  showCode: () => call('devices_show_code'),
  cancelCode: () => call('devices_cancel_code'),
  join: (address, code) => call('devices_join', { address, code }),
  pairAnswer: (id, allow) => call('devices_pair_answer', { id, allow }),
  rename: (node, name) => call('devices_rename', { node, name }),
  setPermission: (node, on, level) => call('devices_set_permission', { node, capability: 'agents/remote', on, ...(on && level ? { level } : {}) }),
  remove: (node) => call('devices_remove', { node }),
  setRoute: (pref) => call('devices_set_route', { pref }),
  makeLink: () => call('devices_make_link'),
  joinLink: (link) => call('devices_join_link', { link }),
  activity: (node) => call('devices_activity', { node }),
  setWeb: (node, on) => call('devices_set_web', { node, on }),
  setDeviceRoute: (node, pref) => call('devices_set_device_route', { node, pref }),
  disconnect: (node) => call('devices_disconnect', { node }),
  screenStart: (node, paneId) => call('devices_screen_start', { node, pane_id: paneId }),
  screenStop: (node, paneId) => call('devices_screen_stop', { node, pane_id: paneId }),
  onScreen: (cb) => (isTauri() ? listen<ScreenFrame>('device://screen', (e) => cb(e.payload)) : Promise.resolve(noop)),
  request: (node, method, path, body) => call('devices_request', { node, method, path, ...(body === undefined ? {} : { body }) }),
  subscribe: (node) => call('devices_subscribe', { node }),
  unsubscribe: (node) => call('devices_unsubscribe', { node }),
  onChanged: (cb) => (isTauri() ? listen<DevicesView>('devices://changed', (e) => cb(e.payload)) : Promise.resolve(noop)),
  onEvent: (cb) => (isTauri() ? listen<DeviceEvent>('device://event', (e) => cb(e.payload)) : Promise.resolve(noop)),
};

// ------------------------------------------------------------------------------------- rules

export const DEVICES_LABS_KEY = 'devices_enabled' as const;

export function devicesEnabled(settings: { devices_enabled?: boolean } | null | undefined): boolean {
  return settings?.devices_enabled === true;
}

/** The Labs switch, read once when the screen opens (the dev build reads every Labs switch as on). */
export function useDevicesEnabled(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    void loadSettings().then(
      (settings) => {
        if (live) setOn(devicesEnabled(settings));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  return on;
}

/** A pane or chat of another device, as this PC names it: `dev:<node>:<paneId>`. Nothing local can look like it. */
export const REMOTE_PREFIX = 'dev:';

export function remoteId(node: string, paneId: string): string {
  return `${REMOTE_PREFIX}${node}:${paneId}`;
}

export function isRemoteId(id: string | null | undefined): boolean {
  return typeof id === 'string' && parseRemoteId(id) !== null;
}

/** `dev:<64 hex>:<pane id>` -> its parts; null for anything else. */
export function parseRemoteId(id: string): { node: string; paneId: string } | null {
  const m = /^dev:([0-9a-f]{64}):(.+)$/.exec(id);
  return m ? { node: m[1], paneId: m[2] } : null;
}

export function isOnline(d: Pick<Device, 'state'>): boolean {
  return d.state === 'online';
}

/** The device group header word (nothing while fine). */
export function stateWord(d: Pick<Device, 'state'> & Partial<Pick<Device, 'too_old' | 'needs_person'>>): string | null {
  switch (d.state) {
    case 'offline':
      return t('devices.offlineShort');
    case 'asleep':
      return t('devices.asleepShort');
    case 'closed':
      return t('devices.closedShort');
    case 'not_allowed':
      return t('devices.notAllowedShort');
    case 'unknown':
      return t('devices.checkingShort');
    default:
      if (d.too_old) return t('devices.tooOldShort');
      return d.needs_person && d.needs_person.length > 0 ? t('devices.needsYouShort') : null;
  }
}

/** The small route chip of a live link ("Direct", "Relay", "Your link"); null when not online. */
export function chipText(d: Pick<Device, 'state' | 'path'>): string | null {
  if (d.state !== 'online' || d.path === null) return null;
  return d.path === 'direct' ? t('devices.chip.direct') : d.path === 'relay' ? t('devices.chip.relay') : t('devices.chip.own');
}

/** `14:02` for a time in unix seconds, in this PC's clock. */
export function clockText(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function lastSeenText(d: Pick<Device, 'last_seen'>): string {
  return d.last_seen === null ? t('devices.neverSeen') : t('devices.lastSeen', { time: clockText(d.last_seen) });
}

/** The one plain sentence under a device's name. */
export function stateSentence(d: Device): string {
  switch (d.state) {
    case 'online':
      if (d.too_old) return t('devices.tooOld', { name: d.name });
      return `${t('devices.online')} · ${d.path === 'relay' ? t('devices.viaRelay') : d.path === 'own' ? t('devices.viaOwn') : t('devices.sameNetwork')}`;
    case 'offline':
      return d.last_seen === null ? t('devices.neverSeen') : t('devices.offline', { time: clockText(d.last_seen) });
    case 'asleep':
      return t('devices.asleep');
    case 'closed':
      return t('devices.closed', { name: d.name });
    case 'not_allowed':
      return t('devices.notAllowed', { name: d.name });
    default:
      return t('devices.checkingShort');
  }
}

/** Why a device cannot be picked right now (null: it can). */
export function cannotPickWhy(d: Device): string | null {
  if (d.state === 'online') return d.too_old ? t('devices.tooOldShort') : null;
  if (d.state === 'not_allowed') return t('devices.notAllowedShort');
  if (d.state === 'offline') return t('devices.offlineShort');
  if (d.state === 'asleep') return t('devices.asleepShort');
  if (d.state === 'closed') return t('devices.closedShort');
  return t('devices.checkingShort');
}

/** One plain notice about a device: a state, a sign-in missing there, or a prompt that needs a person there. */
export interface DeviceNotice {
  id: string;
  kind: 'state' | 'signedOut' | 'needsPerson';
  text: string;
  /** A second, smaller line. */
  hint?: string;
  /** Offer "Try again" (a state that may pass). */
  retry?: boolean;
}

/** Text from another device: control characters out, length capped. */
export function clipText(s: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  return typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '';
}

/** `claude` -> `Claude`. The id came from another device: only its first letter is changed, never matched. */
function agentName(id: string): string {
  const x = clipText(id, 40);
  return x.charAt(0).toUpperCase() + x.slice(1);
}

/**
 * What to tell the person about a device, in order: its state, then each agent that is signed out there, then each
 * prompt that only a person at that device can answer. `agentsOfPane` keeps only the sign-ins of those agents (the
 * pane being looked at); leave it out for all of them and pass `[]` for none (the sidebar). Nothing for a fine device.
 */
export function deviceNotices(d: Device, agentsOfPane?: readonly string[]): DeviceNotice[] {
  const out: DeviceNotice[] = [];
  const name = clipText(d.name, 40);
  const down = d.state === 'offline' || d.state === 'asleep' || d.state === 'closed';
  if (down || d.state === 'not_allowed' || (d.state === 'online' && d.too_old)) {
    out.push({ id: 'state', kind: 'state', text: stateSentence(d), retry: d.state === 'offline' || d.state === 'asleep' });
  }
  if (d.state === 'online') {
    for (const agent of Array.isArray(d.signed_out) ? d.signed_out : []) {
      if (agentsOfPane && !agentsOfPane.includes(agent)) continue;
      out.push({ id: `signed:${agent}`, kind: 'signedOut', text: t('devices.signedOut', { agent: agentName(agent), name }), hint: t('devices.signInThere', { name }) });
    }
  }
  (Array.isArray(d.needs_person) ? d.needs_person : []).forEach((n, i) => {
    out.push({ id: `needs:${i}`, kind: 'needsPerson', text: t('devices.needsPerson', { name, what: clipText(n.what, 200) }) });
  });
  return out;
}

const ACTIVITY_KINDS: readonly ActivityKind[] = ['connected', 'started', 'typed', 'messaged', 'answered', 'stopped', 'changed', 'refused'];

/** Newest first; an entry that is not one of ours is dropped (a bad answer is no line at all). */
export function sortActivity(list: unknown): ActivityEntry[] {
  if (!Array.isArray(list)) return [];
  return (list as ActivityEntry[])
    .filter((e) => e && typeof e.at === 'number' && (e.dir === 'in' || e.dir === 'out') && ACTIVITY_KINDS.includes(e.kind))
    .slice()
    .sort((a, b) => b.at - a.at);
}

/** `14:02 Desk-PC started an agent` (it did it here) or `14:02 Started an agent on Mac mini` (this PC did it there). */
export function activityLine(e: ActivityEntry): string {
  const name = clipText(e.name, 40);
  return `${clockText(e.at)} ${t(`devices.act.${e.dir}.${e.kind}`, { name })}`;
}

/** What the Where picker lists. */
export type Runtime =
  | { kind: 'this'; id: 'this'; label: string }
  | { kind: 'wsl'; id: string; label: string; distro: string }
  | { kind: 'device'; id: string; label: string; device: Device; pickable: boolean; why: string | null };

/** This PC first, then the Linux places of this PC, then each paired device. */
export function runtimesOf(view: DevicesView | null, wslDistros: readonly string[] = []): Runtime[] {
  const out: Runtime[] = [{ kind: 'this', id: 'this', label: t('devices.thisPc') }];
  for (const distro of wslDistros) out.push({ kind: 'wsl', id: `wsl:${distro}`, label: distro, distro });
  if (view?.enabled) {
    for (const device of view.devices) {
      const why = cannotPickWhy(device);
      out.push({ kind: 'device', id: device.node, label: device.name, device, pickable: why === null, why });
    }
  }
  return out;
}

/** Plain words for a refused or failed request to a device. */
export function requestError(name: string, result: RequestResult | Error): string {
  if (result instanceof Error) return result.message;
  const body = (result.body ?? {}) as { error?: unknown; hint?: unknown };
  if (result.status === 403 && body.error === 'not_allowed') return t('devices.notAllowed', { name });
  if (typeof body.hint === 'string') return body.hint;
  return typeof body.error === 'string' ? body.error : `HTTP ${result.status}`;
}
