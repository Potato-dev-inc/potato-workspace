// Example Devices data for the harness and the tests (dev only), and a fake of the `devices_*` commands.
// The fake keeps its own small state, so pairing, the switch, Remove and a link going down really change what the
// screens show. A device here is another PC that runs Potato Workspace; its panes are what `GET /panes` answers.
import { emit, type UnlistenFn } from '@tauri-apps/api/event';
import type { ActivityEntry, CopyResult, Device, DeviceEvent, DeviceLevel, DevicesApi, DevicesView, FarError, FileEntry, FileList, FilePreview, FilesFolders, HostingView, OnExists, PendingPair, RoutePref, ScreenFrame, Transfer } from '../lib/devices';

type Handler = { handled: true; value: unknown } | { handled: false };

export const NODE_MAC = 'a1'.repeat(32);
export const NODE_LAPTOP = 'b2'.repeat(32);
export const NODE_DESK = 'c3'.repeat(32);

const NOW = Math.floor(Date.now() / 1000);

/** The newer fields of a device, all "nothing to say". */
const quiet = (): Pick<Device, 'too_old' | 'lets_files' | 'lets_web' | 'agents_may_send' | 'lets_lend' | 'web_ready' | 'route_override' | 'signed_out' | 'needs_person' | 'connected'> => ({ too_old: false, lets_files: false, lets_web: false, agents_may_send: false, lets_lend: false, web_ready: false, route_override: null, signed_out: [], needs_person: [], connected: false });

export const MAC_MINI: Device = {
  ...quiet(),
  node: NODE_MAC,
  name: 'Mac mini',
  added_at: NOW - 86400,
  state: 'online',
  path: 'direct',
  last_seen: NOW,
  lets_run: false,
  level: 'full',
};

export const WORK_LAPTOP: Device = {
  ...quiet(),
  node: NODE_LAPTOP,
  name: 'Work laptop',
  added_at: NOW - 3 * 86400,
  state: 'offline',
  path: null,
  last_seen: NOW - 2 * 3600,
  lets_run: false,
  level: 'full',
};

/** A pane as the far device's `GET /panes` lists it (the ids are the far device's own). */
export interface RemotePane {
  id: string;
  agent_type: string;
  cwd: string;
  status: string;
  title: string;
  lane?: 'acp';
}

export const MAC_PANES: RemotePane[] = [
  { id: 'p1', agent_type: 'claude', cwd: '/Users/me/app', status: 'running', title: 'Build the .dmg', lane: 'acp' },
  { id: 'p2', agent_type: 'shell', cwd: '/Users/me/app', status: 'idle', title: 'Terminal' },
];

/** What the far device's Files answer in the fake: folders by root, then by path ('' is the root itself). */
export interface FakeFiles {
  /** root name -> directory path -> entries. */
  tree: Record<string, Record<string, FileEntry[]>>;
  /** `root/path` -> what a preview answers. */
  previews?: Record<string, FilePreview>;
  /** Every far call answers this error (the far device refuses). */
  farError?: string;
  /** File names that already exist in Downloads / on the far side: the first copy or send with `ask` answers `exists`. */
  existing?: string[];
  /** What THIS PC shares with the device, and what the person added. */
  folders?: FilesFolders;
}

const T0 = NOW - 3 * 86400;
const PNG_DOT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** The Mac mini's shared folders: "app" (a project) and "notes". */
export const MAC_FILES: FakeFiles = {
  tree: {
    app: {
      '': [
        { name: 'src', kind: 'dir', size: 0, mtime: T0 },
        { name: 'README.md', kind: 'file', size: 1400, mtime: T0 },
        { name: 'logo.png', kind: 'file', size: 82_000, mtime: T0 + 3600 },
        { name: 'build.dmg', kind: 'file', size: 48_000_000, mtime: NOW - 600 },
      ],
      src: [{ name: 'main.rs', kind: 'file', size: 2200, mtime: T0 }],
      build: [{ name: 'app.dmg', kind: 'file', size: 48_000_000, mtime: NOW - 600 }],
    },
    notes: { '': [{ name: 'todo.txt', kind: 'file', size: 120, mtime: T0 }] },
  },
  previews: {
    'app/README.md': { kind: 'text', text: '# app\n\nA small app. Run it with make.', truncated: false, size: 1400 },
    'app/logo.png': { kind: 'image', mime: 'image/png', data: PNG_DOT, size: 82_000 },
    'app/build.dmg': { kind: 'none', size: 48_000_000, too_big: true },
  },
  folders: { shared: ['app', 'notes'], chosen: [] },
};

export interface DevicesScenario {
  /** Far files, shared folders and transfers. */
  files?: FakeFiles;
  transfers?: Transfer[];
  /** `GET /panes/<id>/chat` items by far pane id. */
  chats?: Record<string, unknown[]>;
  /** Default true: the switch is on. */
  enabled?: boolean;
  name?: string;
  devices?: Device[];
  route_pref?: RoutePref;
  /** What each device's `GET /panes` answers. */
  panes?: Record<string, RemotePane[]>;
  own_route_ready?: boolean;
  /** What `devices_activity` answers. */
  activity?: ActivityEntry[];
  /** The "Show a code" sheet starts showing this. */
  hosting?: HostingView;
  /** The both-confirm sheet is already open. */
  pending?: PendingPair;
  message?: string;
  /** The Mac mini goes offline this many ms after the page opens (a pulled cable), and the screens are told. */
  offlineAfterMs?: number;
  /** Later changes of a device (asleep, closed, needs a person…), this many ms after the page opens. */
  changeAfter?: { ms: number; node: string; patch: Partial<Device> }[];
  /** What a live terminal shows once it starts. */
  screen?: string;
}

function baseView(s: DevicesScenario): DevicesView {
  return {
    enabled: s.enabled !== false,
    name: s.name ?? 'Desk-PC',
    route_pref: s.route_pref ?? 'auto',
    own_route_ready: s.own_route_ready === true,
    hosting: s.hosting ?? null,
    pending: s.pending ?? null,
    joining: null,
    message: s.message ?? null,
    locked_until: null,
    tampered: false,
    devices: (s.devices ?? []).map((d) => ({ ...d })),
    transfers: (s.transfers ?? []).map((x) => ({ ...x })),
  };
}

export class DevicesFake implements DevicesApi {
  view: DevicesView;
  panes: Record<string, RemotePane[]>;
  requests: { node: string; method: string; path: string; body?: unknown }[] = [];
  private changed = new Set<(v: DevicesView) => void>();
  private events = new Set<(e: DeviceEvent) => void>();
  private waiting: ((allow: boolean) => void) | null = null;
  subscribed = new Set<string>();
  activityLog: ActivityEntry[];
  screens = new Set<(f: ScreenFrame) => void>();
  screenStarts: string[] = [];
  screenStops: string[] = [];
  files: FakeFiles;
  chats: Record<string, unknown[]>;
  /** Every files call, in order. */
  fileCalls: { cmd: string; args: Record<string, unknown> }[] = [];
  private nextTransfer = 1;
  /** Make `screenStart` fail (the far side cannot stream): the view falls back to one snapshot. */
  screenFails = false;

  constructor(s: DevicesScenario = {}) {
    this.view = baseView(s);
    this.files = s.files ?? { tree: {} };
    this.chats = s.chats ?? {};
    this.nextTransfer = Math.max(0, ...this.view.transfers.map((x) => x.id)) + 1;
    this.folders = { shared: this.files.folders?.shared ?? [], chosen: this.files.folders?.chosen ?? [] };
    this.activityLog = (s.activity ?? []).map((e) => ({ ...e }));
    this.panes = Object.fromEntries(Object.entries(s.panes ?? {}).map(([k, v]) => [k, v.map((p) => ({ ...p }))]));
  }

  private emit(): DevicesView {
    this.view = { ...this.view, devices: this.view.devices.map((d) => ({ ...d })) };
    for (const cb of this.changed) cb(this.view);
    return this.view;
  }

  /** The link to a device changed (a cable pulled, plugged back). */
  setDevice(node: string, patch: Partial<Device>): void {
    this.view.devices = this.view.devices.map((d) => (d.node === node ? { ...d, ...patch } : d));
    this.emit();
  }

  /** The other device typed my code: the confirm sheet shows (host side). */
  simulateIncoming(name: string, code: string): void {
    this.view = { ...this.view, hosting: null, pending: { id: 7, role: 'host', name, code, expires_at: Date.now() + 120_000 } };
    this.waiting = (allow) => {
      this.view = { ...this.view, pending: null };
      if (allow) this.addDevice(name);
      this.emit();
    };
    this.emit();
  }

  private addDevice(name: string): void {
    const node = (this.view.devices.length % 2 === 0 ? 'd4' : 'e5').repeat(32);
    this.view.devices = [...this.view.devices, { ...quiet(), node, name, added_at: NOW, state: 'online', path: 'direct', last_seen: NOW, lets_run: false, level: 'watch' }];
    // The words the backend sends (src-tauri/src/p2p/pairing.rs). The screen replaces this line with its own next step
    // for the device that just appeared.
    this.view.message = `Paired with ${name}. Nothing is shared yet: turn on what you want below.`;
  }

  emitEvent(e: DeviceEvent): void {
    for (const cb of this.events) cb(e);
  }

  private folders: FilesFolders;
  private far = (node: string): FarError | null => {
    const d = this.view.devices.find((x) => x.node === node);
    if (!d || d.state === 'offline' || d.state === 'unknown') return { ok: false, error: 'That device is offline.', code: 'offline' };
    return this.files.farError ? { ok: false, error: this.files.farError, code: 'refused' } : null;
  };
  setFiles = async (node: string, on: boolean) => {
    this.fileCalls.push({ cmd: 'setFiles', args: { node, on } });
    this.setDevice(node, { lets_files: on });
    return this.view;
  };
  filesFolders = async (node: string): Promise<FilesFolders> => {
    this.fileCalls.push({ cmd: 'filesFolders', args: { node } });
    return { shared: [...this.folders.shared], chosen: [...this.folders.chosen] };
  };
  setFilesFolders = async (node: string, folders: string[]): Promise<FilesFolders> => {
    this.fileCalls.push({ cmd: 'setFilesFolders', args: { node, folders } });
    if (folders.some((f) => f.includes('not-a-folder'))) throw new Error('That is not a folder.');
    this.folders = { ...this.folders, chosen: [...folders] };
    return { shared: [...this.folders.shared], chosen: [...folders] };
  };
  filesRoots = async (node: string): Promise<{ roots: string[] } | FarError> => {
    this.fileCalls.push({ cmd: 'filesRoots', args: { node } });
    return this.far(node) ?? { roots: Object.keys(this.files.tree) };
  };
  filesList = async (node: string, root: string, path: string): Promise<FileList | FarError> => {
    this.fileCalls.push({ cmd: 'filesList', args: { node, root, path } });
    const err = this.far(node);
    if (err) return err;
    const dir = this.files.tree[root]?.[path];
    if (!dir) return { ok: false, error: 'That folder is not shared on this device.', code: 'not_shared' };
    return { entries: dir.map((e) => ({ ...e })), truncated: false };
  };
  filesPreview = async (node: string, root: string, path: string): Promise<FilePreview | FarError> => {
    this.fileCalls.push({ cmd: 'filesPreview', args: { node, root, path } });
    const err = this.far(node);
    if (err) return err;
    return this.files.previews?.[`${root}/${path}`] ?? { kind: 'none', size: 0 };
  };
  private startTransfer(node: string, dir: 'down' | 'up', name: string, total: number): CopyResult {
    const id = this.nextTransfer++;
    this.view = { ...this.view, transfers: [{ id, node, dir, name, bytes: 0, total, state: 'running', error: '', saved_as: dir === 'down' ? name : '' }, ...this.view.transfers] };
    this.emit();
    return { ok: true, id };
  }
  /** The backend pushes progress: this moves one transfer on and tells the screens. */
  progress(id: number, patch: Partial<Transfer>): void {
    this.view = { ...this.view, transfers: this.view.transfers.map((x) => (x.id === id ? { ...x, ...patch } : x)) };
    this.emit();
  }
  filesCopy = async (a: { node: string; root: string; paths: string[]; dest?: string | null; on_exists?: OnExists }): Promise<CopyResult> => {
    this.fileCalls.push({ cmd: 'filesCopy', args: { ...a } });
    const err = this.far(a.node);
    if (err) return err;
    const name = a.paths.length === 1 ? (a.paths[0]!.split('/').pop() ?? '') : `${a.paths.length} items`;
    if ((a.on_exists ?? 'ask') === 'ask' && a.paths.length === 1 && this.files.existing?.includes(name)) return { exists: true, name };
    const r = this.startTransfer(a.node, 'down', name, 48_000_000);
    if (a.on_exists === 'both' && 'id' in r) this.progress(r.id, { saved_as: name.replace(/(\.[^.]*)?$/, ' (2)$1') });
    return r;
  };
  filesSend = async (a: { node: string; root: string; dir: string; local: string[]; on_exists?: OnExists }): Promise<CopyResult> => {
    this.fileCalls.push({ cmd: 'filesSend', args: { ...a } });
    const err = this.far(a.node);
    if (err) return err;
    const name = (a.local[0] ?? '').split(/[\\/]/).pop() ?? '';
    if ((a.on_exists ?? 'ask') === 'ask' && a.local.length === 1 && this.files.existing?.includes(name)) return { exists: true, name };
    return this.startTransfer(a.node, 'up', a.local.length === 1 ? name : `${a.local.length} items`, 8_000_000);
  };
  transferCancel = async (id: number) => {
    this.fileCalls.push({ cmd: 'transferCancel', args: { id } });
    this.progress(id, { state: 'stopped' });
    return this.view;
  };
  transfersClear = async () => {
    this.fileCalls.push({ cmd: 'transfersClear', args: {} });
    this.view = { ...this.view, transfers: this.view.transfers.filter((x) => x.state === 'running') };
    return this.emit();
  };

  stateCalls = 0;
  state = async () => (this.stateCalls++, this.view);
  showCode = async () => {
    this.view = { ...this.view, hosting: { kind: 'code', code: '4F7Q-9K2M', address: 'pm1:' + 'f6'.repeat(32) + '@192.168.1.20:47111', expires_at: Date.now() + 120_000 } };
    return this.emit();
  };
  cancelCode = async () => {
    this.view = { ...this.view, hosting: null };
    return this.emit();
  };
  join = async (address: string, code: string) => {
    if (!address.startsWith('pm1:') || code.trim() === '') throw new Error('That address or code does not look right.');
    return this.pairAsJoiner(code.trim().toUpperCase());
  };
  makeLink = async () => {
    this.view = { ...this.view, hosting: { kind: 'link', code: '', address: '', link: 'pm1link:' + 'ab12'.repeat(30), expires_at: Date.now() + 600_000 } };
    return this.emit();
  };
  joinLinks: string[] = [];
  joinLink = async (link: string) => {
    this.joinLinks.push(link);
    if (!link.startsWith('pm1link:')) throw new Error('That link does not look right.');
    return this.pairAsJoiner('7K2M-4F9Q');
  };
  activity = async (node?: string) => this.activityLog.filter((e) => !node || e.node === node).map((e) => ({ ...e }));
  setWeb = async (node: string, on: boolean) => {
    this.setDevice(node, { lets_web: on });
    return this.view;
  };
  setLend = async (node: string, on: boolean) => {
    this.setDevice(node, { lets_lend: on });
    return this.view;
  };
  setAgentsSend = async (node: string, on: boolean) => {
    this.setDevice(node, { agents_may_send: on });
    return this.view;
  };
  setDeviceRoute = async (node: string, pref: RoutePref | null) => {
    this.setDevice(node, { route_override: pref });
    return this.view;
  };
  disconnect = async (node: string) => {
    this.setDevice(node, { connected: false, lets_run: false });
    return this.view;
  };
  screenStart = async (node: string, paneId: string) => {
    if (this.screenFails) throw new Error('No live screen.');
    this.screenStarts.push(`${node}:${paneId}`);
  };
  screenStop = async (node: string, paneId: string) => void this.screenStops.push(`${node}:${paneId}`);
  onScreen = async (cb: (f: ScreenFrame) => void): Promise<UnlistenFn> => {
    this.screens.add(cb);
    return () => this.screens.delete(cb);
  };
  emitScreen(f: ScreenFrame): void {
    for (const cb of this.screens) cb(f);
  }
  private pairAsJoiner = async (code: string) => {
    this.view = { ...this.view, joining: 'Looking for the other computer…', pending: { id: 8, role: 'joiner', name: 'Studio PC', code, expires_at: Date.now() + 120_000 } };
    this.emit();
    const allow = await new Promise<boolean>((resolve) => {
      this.waiting = resolve;
    });
    this.view = { ...this.view, joining: null, pending: null };
    if (!allow) {
      this.emit();
      throw new Error('You said no.');
    }
    this.addDevice('Studio PC');
    return this.emit();
  };
  pairAnswer = async (_id: number, allow: boolean) => {
    const w = this.waiting;
    this.waiting = null;
    w?.(allow);
    return this.view;
  };
  rename = async (node: string, name: string) => {
    this.setDevice(node, { name });
    return this.view;
  };
  setPermission = async (node: string, on: boolean, level?: DeviceLevel) => {
    this.setDevice(node, { lets_run: on, ...(level ? { level } : {}) });
    return this.view;
  };
  remove = async (node: string) => {
    this.view = { ...this.view, devices: this.view.devices.filter((d) => d.node !== node) };
    return this.emit();
  };
  setRoute = async (pref: RoutePref) => {
    this.view = { ...this.view, route_pref: pref };
    return this.emit();
  };
  request = async (node: string, method: string, path: string, body?: unknown) => {
    this.requests.push({ node, method, path, body });
    const d = this.view.devices.find((x) => x.node === node);
    if (!d || d.state === 'offline' || d.state === 'unknown') throw new Error('That device is offline.');
    if (d.state === 'not_allowed') return { status: 403, body: { error: 'not_allowed' } };
    const list = (this.panes[node] ??= []);
    if (method === 'GET' && path === '/panes') {
      return { status: 200, body: list.map((p, i) => ({ id: p.id, agent_type: p.agent_type, pid: 100 + i, status: p.status, created_at: NOW, last_output_at: null, cwd: p.cwd, cols: 100, rows: 30, title: p.title, ...(p.lane ? { lane: p.lane } : {}) })) };
    }
    if (method === 'POST' && (path === '/acp/sessions' || path === '/panes')) {
      const b = (body ?? {}) as { agent?: string; agent_type?: string; folder?: string; cwd?: string };
      const id = `n${list.length + 1}`;
      list.push({ id, agent_type: b.agent ?? b.agent_type ?? 'claude', cwd: b.folder ?? b.cwd ?? '/', status: 'idle', title: 'New', ...(path === '/acp/sessions' ? { lane: 'acp' as const } : {}) });
      this.emit();
      return { status: 200, body: { pane_id: id, snapshot: { pane_id: id } } };
    }
    // The far device's own agents and recent projects (the phone's new-chat screen reads these).
    if (method === 'GET' && path === '/phone/new-chat') {
      return {
        status: 200,
        body: {
          agents: [
            { id: 'claude', label: 'Claude', chat: true, terminal: true },
            { id: 'codex', label: 'Codex', chat: true, terminal: true },
          ],
          projects: [{ id: 'proj-app', name: 'app', state: 'ready' }],
          terminals: true,
        },
      };
    }
    if (method === 'POST' && path === '/phone/chats') {
      const b = (body ?? {}) as { agent?: string; lane?: string };
      const id = `n${list.length + 1}`;
      list.push({ id, agent_type: b.agent ?? 'claude', cwd: '/Users/me/app', status: 'idle', title: 'New chat', ...(b.lane === 'chat' ? { lane: 'acp' as const } : {}) });
      this.emit();
      return { status: 200, body: { pane_id: id, agent: b.agent ?? 'claude', lane: b.lane ?? 'chat' } };
    }
    // Take the conversation and the work: the far side checks a git bundle out in one of its projects.
    if (method === 'POST' && path === '/phone/move-work') return { status: 200, body: { ok: true, branch: (body as { branch?: string })?.branch ?? '', sha: 'f'.repeat(40) } };
    if (method === 'POST' && /^\/panes\/[^/]+\/messages/.test(path)) return { status: 200, body: { message: { id: 'm1', text: (body as { text?: string })?.text ?? '', state: 'sent' } } };
    if (method === 'GET' && /^\/panes\/[^/]+\/snapshot/.test(path)) return { status: 200, body: { content: '$ make dmg\nBuilding...' } };
    if (method === 'POST' && /^\/panes\/[^/]+\/input/.test(path)) return { status: 200, body: { ok: true } };
    if (method === 'GET' && /^\/panes\/[^/]+\/result/.test(path)) {
      return { status: 200, body: { available: true, turn: 1, sentence: 'Claude edited 2 files (+48 -12), now idle.', durationMs: 45_000, files: { count: 2, added: 48, deleted: 12, paths: [] }, tests: 'all checks passed (3/3)', changes: [{ path: 'src/auth/redirect.ts', status: 'M', added: 30, deleted: 8, binary: false }, { path: 'src/auth/session.ts', status: 'M', added: 18, deleted: 4, binary: false }] } };
    }
    if (method === 'GET' && /^\/panes\/[^/]+\/chat/.test(path)) {
      const id = decodeURIComponent(path.split('/')[2] ?? '');
      return { status: 200, body: { available: true, reason: null, source: 'file', waitingFor: null, rev: 1, reset: false, items: this.chats[id] ?? [], revision: 1 } };
    }
    return { status: 404, body: { error: 'not found' } };
  };
  subscribe = async (node: string) => void this.subscribed.add(node);
  unsubscribe = async (node: string) => void this.subscribed.delete(node);
  onChanged = async (cb: (v: DevicesView) => void): Promise<UnlistenFn> => {
    this.changed.add(cb);
    return () => this.changed.delete(cb);
  };
  onEvent = async (cb: (e: DeviceEvent) => void): Promise<UnlistenFn> => {
    this.events.add(cb);
    return () => this.events.delete(cb);
  };
}

/** One mock per harness page: answers the `devices_*` commands from the scenario. `handled: false` leaves a command alone. */
export function createDevicesMock(s: DevicesScenario | undefined): (cmd: string, args: Record<string, unknown>) => Handler {
  const fake = new DevicesFake(s ?? { enabled: false });
  if (s?.offlineAfterMs !== undefined) {
    setTimeout(() => {
      fake.setDevice(NODE_MAC, { state: 'offline', path: null, last_seen: Math.floor(Date.now() / 1000) - 60 });
      void emit('devices://changed', fake.view);
    }, s.offlineAfterMs);
  }
  for (const c of s?.changeAfter ?? []) {
    setTimeout(() => {
      fake.setDevice(c.node, c.patch);
      void emit('devices://changed', fake.view);
    }, c.ms);
  }
  return (cmd, a) => {
    if (!cmd.startsWith('devices_')) return { handled: false };
    const v = (value: unknown): Handler => ({ handled: true, value });
    switch (cmd) {
      case 'devices_state':
        return v(fake.view);
      case 'devices_show_code':
        return v(fake.showCode());
      case 'devices_cancel_code':
        return v(fake.cancelCode());
      case 'devices_join':
        return v(fake.join(String(a.address), String(a.code)));
      case 'devices_pair_answer':
        return v(fake.pairAnswer(Number(a.id), a.allow === true));
      case 'devices_rename':
        return v(fake.rename(String(a.node), String(a.name)));
      case 'devices_set_permission':
        return v(fake.setPermission(String(a.node), a.on === true, a.level as DeviceLevel | undefined));
      case 'devices_remove':
        return v(fake.remove(String(a.node)));
      case 'devices_set_route':
        return v(fake.setRoute(a.pref as RoutePref));
      case 'devices_request':
        return v(fake.request(String(a.node), String(a.method), String(a.path), a.body));
      case 'devices_make_link':
        return v(fake.makeLink());
      case 'devices_join_link':
        return v(fake.joinLink(String(a.link)));
      case 'devices_activity':
        return v(fake.activity(a.node === undefined ? undefined : String(a.node)));
      case 'devices_set_lend':
        return v(fake.setLend(String(a.node), a.on === true));
      case 'devices_set_agents_send':
        return v(fake.setAgentsSend(String(a.node), a.on === true));
      case 'devices_set_web':
        return v(fake.setWeb(String(a.node), a.on === true));
      case 'devices_set_device_route':
        return v(fake.setDeviceRoute(String(a.node), (a.pref ?? null) as RoutePref | null));
      case 'devices_disconnect':
        return v(fake.disconnect(String(a.node)));
      case 'devices_screen_start':
        setTimeout(() => void emit('device://screen', { node: String(a.node), pane_id: String(a.pane_id), content: s?.screen ?? '$ make dmg\nBuilding...' }), 50);
        return v(fake.screenStart(String(a.node), String(a.pane_id)));
      case 'devices_screen_stop':
        return v(fake.screenStop(String(a.node), String(a.pane_id)));
      case 'devices_set_files':
        return v(fake.setFiles(String(a.node), a.on === true));
      case 'devices_files_folders':
        return v(fake.filesFolders(String(a.node)));
      case 'devices_files_set_folders':
        return v(fake.setFilesFolders(String(a.node), (a.folders as string[]) ?? []));
      case 'devices_files_roots':
        return v(fake.filesRoots(String(a.node)));
      case 'devices_files_list':
        return v(fake.filesList(String(a.node), String(a.root), String(a.path ?? '')));
      case 'devices_files_preview':
        return v(fake.filesPreview(String(a.node), String(a.root), String(a.path ?? '')));
      case 'devices_files_copy':
        return v(fake.filesCopy({ node: String(a.node), root: String(a.root), paths: (a.paths as string[]) ?? [], dest: (a.dest as string | null | undefined) ?? null, on_exists: a.on_exists as OnExists | undefined }));
      case 'devices_files_send':
        return v(fake.filesSend({ node: String(a.node), root: String(a.root), dir: String(a.dir ?? ''), local: (a.local as string[]) ?? [], on_exists: a.on_exists as OnExists | undefined }));
      case 'devices_transfer_cancel':
        return v(fake.transferCancel(Number(a.id)));
      case 'devices_transfers_clear':
        return v(fake.transfersClear());
      case 'devices_subscribe':
      case 'devices_unsubscribe':
        return v(null);
      default:
        return { handled: false };
    }
  };
}
