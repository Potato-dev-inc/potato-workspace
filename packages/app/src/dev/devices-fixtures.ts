// Example Devices data for the harness and the tests (dev only), and a fake of the `devices_*` commands.
// The fake keeps its own small state, so pairing, the switch, Remove and a link going down really change what the
// screens show. A device here is another PC that runs Potato Workspace; its panes are what its `GET /pclink/sessions` answers.
import { emit, type UnlistenFn } from '@tauri-apps/api/event';
import type { PcLevel } from '../lib/runtime/pclink';
import { StubShell } from './far-shell-stub';
import type { UsageSnapshot } from '../lib/usage';
import type { ActivityEntry, CopyResult, Device, DeviceEvent, DeviceLevel, DevicesApi, DevicesView, FarError, FileEntry, FullAsk, FileList, FilePreview, FilesFolders, HostingView, OnExists, PendingPair, RoutePref, Transfer } from '../lib/devices';

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
  parent_pane_id?: string;
  /** The rest of the row a far PC's own registry gives (`sessions_rows.rs`). */
  started_as?: 'minion' | 'spin_off';
  standby_seat?: string;
  copy?: boolean;
  workflow?: { slug: string; role: string; front: boolean; name?: string };
  /** What the far PC says about the chat (its session list's read-only facts). */
  model?: string;
  mode?: 'asks' | 'acts_without_asking';
  branch?: string;
}


/** One session row as a newer far PC lists it (`GET /pclink/sessions`, `sessions_rows.rs`): the same JSON for every fixture pane. */
export const sessionRowOf = (p: RemotePane) => ({
  id: p.id,
  agent: p.agent_type,
  title: p.title,
  status: p.status,
  project: `p-${p.cwd}`,
  folder: p.cwd.split('/').filter(Boolean).pop() ?? '',
  chat: p.lane === 'acp',
  ...(p.lane ? { lane: p.lane } : {}),
  ...(p.model ? { model: p.model } : {}),
  ...(p.mode ? { mode: p.mode } : {}),
  ...(p.branch ? { branch: p.branch } : {}),
  ...(p.parent_pane_id ? { parent: p.parent_pane_id, helper_of: p.parent_pane_id } : {}),
  ...(p.started_as ? { started_as: p.started_as } : {}),
  ...(p.standby_seat ? { standby: true } : {}),
  ...(p.copy ? { copy: true } : {}),
  ...(p.workflow ? { workflow: p.workflow } : {}),
});

/** A far PC's registry for the P2.4 shots and the sameness test: a workflow front with a spin-off and a minion, a standby's own chat, a chat on a copy, untitled agents. A copy's folder there is its REAL project (the row says `copy`). */
export const PM_NIGHT_PANES: RemotePane[] = [
  { id: 'front', agent_type: 'opencode', cwd: '/w/pm-night', status: 'idle', title: '', lane: 'acp', workflow: { slug: 'wf', role: 'Front', front: true, name: 'Research + Write' } },
  { id: 'h1', agent_type: 'claude', cwd: '/w/pm-night', status: 'running', title: 'Research', lane: 'acp', parent_pane_id: 'front', started_as: 'spin_off' },
  { id: 'h2', agent_type: 'claude', cwd: '/w/pm-night', status: 'running', title: 'Scratch', lane: 'acp', parent_pane_id: 'front', started_as: 'minion' },
  { id: 'seat', agent_type: 'claude', cwd: '/w/pm-night', status: 'idle', title: 'Standby', lane: 'acp', standby_seat: 'seat1' },
  { id: 'copy', agent_type: 'claude', cwd: '/w/pm-night', status: 'idle', title: 'Fix on a copy', lane: 'acp', copy: true },
  { id: 'plain', agent_type: 'opencode', cwd: '/w/pm-night', status: 'error', title: '', lane: 'acp' },
];

/** The chat settings a far PC offers (what its `acp_chat_state` answers): permission, model and effort, like the local chat's. */
const opt = (id: string, name: string, category: string, current: string, values: [string, string][]) => ({ id, name, category, type: 'select', currentValue: current, options: values.map(([value, label]) => ({ value, name: label })) });
export const farChatState = (paneId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  lane: 'acp',
  agent: 'claude',
  label: 'Claude',
  phase: 'idle',
  status: 'idle',
  turnInFlight: false,
  stopping: false,
  quietSecs: 0,
  canSteer: false,
  turn: 1,
  epoch: 1,
  revision: 1,
  title: null,
  usage: { used: 1200, size: 20000 },
  commands: [],
  configOptions: [
    opt('mode', 'Permissions', 'mode', 'default', [['default', 'Ask first'], ['plan', 'Plan'], ['bypassPermissions', 'Full access']]),
    opt('model', 'Model', 'model', 'sonnet', [['sonnet', 'Sonnet 5.5'], ['opus', 'Opus 5'], ['haiku', 'Haiku 5']]),
    opt('effort', 'Effort', 'thought_level', 'medium', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]),
  ],
  modes: null,
  historyLost: null,
  permissions: [],
  exit: null,
  closed: false,
  conversation: paneId,
  inTerminal: null,
  agentAnswering: false,
  forceYes: false,
  interruptedTurn: false,
  signIn: { needed: false, hint: '' },
  ...over,
});

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
  /** Per device: the folders its `GET /pclink/projects` lists. */
  projectsOf?: Record<string, { id: string; name: string; state: string }[]>;
  /** Per device: the agents its registry lists (`agents_list`); default Claude and Codex, both installed. */
  agentsOf?: Record<string, FarAgent[]>;
  /** Per device: what its `GET /pclink/usage` answers. */
  usageOf?: Record<string, UsageSnapshot>;
  /** Per device: the places it offers to browse, and the folders in each (`<root id>|<sub>` to names). */
  browseTree?: Record<string, { roots: { id: string; name: string }[]; dirs: Record<string, string[]> }>;
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

/** One agent of a far PC's registry (`agents_list`): installed or not. */
export interface FarAgent {
  id: string;
  label: string;
  installed?: boolean;
}
const DEFAULT_FAR_AGENTS: FarAgent[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
];
/** The registry row the app's `agents_list` gives for an agent (`AgentDescriptor`). */
const descriptorOf = (a: FarAgent) => ({
  id: a.id,
  label: a.label,
  icon: null,
  kind: 'cli',
  source: 'code',
  experimental: false,
  dispatchable: true,
  not_dispatchable_reason: null,
  installed: a.installed !== false,
  install_hint: null,
  modes: { headless: false, visible: true },
  features: { read_only_headless: false, read_only_spawned_pane: false, resumable_headless: false },
  run_options: { trust_workspace: false, allow_shell: false, shell_default_on: false, allowed_commands: false },
  standby: { visible: false, headless: false, experimental: false },
  definition: null,
});

export class DevicesFake implements DevicesApi {
  view: DevicesView;
  panes: Record<string, RemotePane[]>;
  requests: { node: string; method: string; path: string; body?: unknown }[] = [];
  /** Per far chat: the settings state its `acp_chat_state` answers (default: `farChatState`); `set_config` and `set_force_yes` change it. */
  chatStates: Record<string, Record<string, unknown>> = {};
  private lastCallArgs: Record<string, unknown> = {};
  /** The far calls that were answered (`POST /pclink/call/<cmd>`), in order. */
  farCalls: { cmd: string; args: Record<string, unknown> }[] = [];
  private changed = new Set<(v: DevicesView) => void>();
  private events = new Set<(e: DeviceEvent) => void>();
  private waiting: ((allow: boolean) => void) | null = null;
  subscribed = new Set<string>();
  activityLog: ActivityEntry[];
  files: FakeFiles;
  chats: Record<string, unknown[]>;
  /** Every files call, in order. */
  fileCalls: { cmd: string; args: Record<string, unknown> }[] = [];
  private nextTransfer = 1;

  constructor(s: DevicesScenario = {}) {
    this.view = baseView(s);
    this.files = s.files ?? { tree: {} };
    this.chats = s.chats ?? {};
    this.nextTransfer = Math.max(0, ...this.view.transfers.map((x) => x.id)) + 1;
    this.folders = { shared: this.files.folders?.shared ?? [], chosen: this.files.folders?.chosen ?? [] };
    this.activityLog = (s.activity ?? []).map((e) => ({ ...e }));
    this.panes = Object.fromEntries(Object.entries(s.panes ?? {}).map(([k, v]) => [k, v.map((p) => ({ ...p }))]));
    this.projectsOf = { ...(s.projectsOf ?? {}) };
    this.agentsOf = { ...(s.agentsOf ?? {}) };
    this.usageOf = { ...(s.usageOf ?? {}) };
    this.browseTree = { ...(s.browseTree ?? {}) };
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
    this.alsoEmit?.(e);
  }
  /** The harness page also gets the event as the Tauri event `device://event`. */
  alsoEmit?: (e: DeviceEvent) => void;

  // ----- P2.3: a stub far shell behind `POST /pclink/call/<cmd>` (a script, not a pty; see far-shell-stub.ts) -----
  /** What this PC typed into the far terminal and the grids it asked for. */
  farInput: string[] = [];
  farResizes: Array<[number, number]> = [];
  private farBytes = 0;
  private farShells = new Map<string, StubShell>();
  private farShell(node: string): StubShell {
    let shell = this.farShells.get(node);
    if (!shell) {
      shell = new StubShell((data) => {
        const bytes = new TextEncoder().encode(data);
        const payload = { pane_id: 'p2', b64: btoa(String.fromCharCode(...bytes)), offset: this.farBytes };
        this.farBytes += bytes.length;
        this.emitEvent({ node, frame: `event: app
data: ${JSON.stringify({ event: 'terminal-data', payload })}

` });
      });
      this.farBytes = new TextEncoder().encode(shell.screen).length;
      this.farShells.set(node, shell);
    }
    return shell;
  }
  farKilled: string[] = [];
  private farCall(node: string, cmd: string, body: Record<string, unknown>, need: (needs: PcLevel) => { status: number; body: unknown } | null): { status: number; body: unknown } {
    const shell = this.farShell(node);
    const full = need('full');
    switch (cmd) {
      case 'list_panes':
        return full ?? { status: 200, body: [] };
      case 'read_pane_screen_replay':
        if (full) return full;
        return { status: 200, body: { data: [...new TextEncoder().encode(shell.screen)], cols: 100, rows: 28, offset: this.farBytes } };
      case 'write_pane_input': {
        if (full) return full;
        const text = String(((body.args ?? body) as { text?: unknown }).text ?? '');
        this.farInput.push(text);
        shell.type(text);
        return { status: 200, body: null };
      }
      case 'kill_pane_cmd':
        if (full) return full;
        this.farKilled.push(String(body.paneId));
        return { status: 200, body: null };
      case 'resize_pane':
        if (full) return full;
        this.farResizes.push([Number(body.cols), Number(body.rows)]);
        return { status: 200, body: null };
      default:
        return { status: 404, body: { error: 'not found', code: 'UNKNOWN_ROUTE' } };
    }
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
  /** A pairing sheet that is not one of the built-in stories (a PC of the person's own account): its owner gets every answer. */
  private answerHook: ((pick: string | null) => void) | null = null;
  showPending(p: PendingPair, onAnswer: (pick: string | null) => void): void {
    this.view = { ...this.view, pending: p, joining: null };
    this.answerHook = onAnswer;
    this.emit();
  }
  clearPending(): void {
    this.answerHook = null;
    this.view = { ...this.view, pending: null, joining: null };
    this.emit();
  }
  addPairedDevice(d: Device): void {
    this.view = { ...this.view, devices: [...this.view.devices.filter((x) => x.node !== d.node), { ...d }] };
    this.emit();
  }
  pairAnswer = async (_id: number, allow: boolean) => {
    if (this.answerHook) {
      const h = this.answerHook;
      this.answerHook = null;
      h(allow ? 'yes' : null);
      return this.view;
    }
    const w = this.waiting;
    this.waiting = null;
    w?.(allow);
    return this.view;
  };
  /** The numbers the person picked in check mode (in order). */
  pickCalls: string[] = [];
  /** Check mode: the other PC's name, fingerprint and three numbers; `right` is the one both screens show. */
  simulateIncomingCheck(name: string, right: string): void {
    const choices = ['012345', '678901', '234567'];
    this.view = { ...this.view, hosting: null, pending: { id: 9, role: 'host', name, code: '', expires_at: Date.now() + 120_000, mode: 'check', fingerprint: 'A1B2 C3D4', choices } };
    this.waiting = (allow) => {
      this.view = { ...this.view, pending: null };
      if (allow) this.addDevice(name);
      this.emit();
    };
    this.checkRight = right;
    this.emit();
  }
  private checkRight = '';
  pairPick = async (_id: number, pick: string) => {
    this.pickCalls.push(pick);
    if (this.answerHook) {
      const h = this.answerHook;
      this.answerHook = null;
      h(pick);
      return this.view;
    }
    const w = this.waiting;
    this.waiting = null;
    w?.(pick === this.checkRight);
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
    // The far PC's own routes (`/pclink/...`), with the level the far PC gave this PC. Anything else is not served to a PC.
    const segs = path.split('?')[0]!.split('/').filter(Boolean);
    if (segs[0] !== 'pclink') return { status: 404, body: { error: 'not found', code: 'USE_PCLINK' } };
    const level = this.levelOf(node);
    const denied = (needs: PcLevel) => ({ status: 403, body: { error: 'not_allowed', code: 'DEVICE_NOT_ALLOWED', needs, have: level } });
    const rank = { watch: 0, answer: 1, full: 2 } as const;
    const need = (needs: PcLevel) => (rank[level] >= rank[needs] ? null : denied(needs));
    const id = decodeURIComponent(segs[2] ?? '');
    // P2.3: the terminal rows are served by the stub far shell (far-shell-stub.ts).
    if (method === 'POST' && segs[1] === 'call' && ['list_panes', 'spawn_pane', 'read_pane_screen_replay', 'read_pane_raw_buffer', 'write_pane_input', 'resize_pane', 'kill_pane_cmd'].includes(segs[2] ?? '')) return this.farCall(node, segs[2] ?? '', (body ?? {}) as Record<string, unknown>, need);
    // The far call table (`pclink/calls.rs`): the chat-settings family and the chat feed rows, at the levels its rows say. Any other command is not a row (404).
    if (method === 'POST' && segs[1] === 'call') {
      const cmd = segs[2] ?? '';
      const a = (body ?? {}) as Record<string, unknown>;
      const levelOf: Record<string, PcLevel> = {
        acp_chat_state: 'watch',
        agent_model_options: 'watch',
        acp_chat_set_config: 'full',
        acp_chat_set_force_yes: 'full',
        session_chat_open: 'watch',
        session_chat_close: 'watch',
        chat_earlier: 'watch',
        chat_picture: 'watch',
        acp_chat_cancel: 'answer',
        pane_message_send: 'answer',
        pane_message_cancel: 'answer',
        pane_message_hold: 'answer',
        pane_message_edit: 'answer',
        pane_messages_list: 'answer',
        acp_chat_keep_waiting: 'answer',
        acp_chat_take_back: 'full',
        acp_chat_set_auto_allow: 'full',
        acp_chat_set_agent_answering: 'full',
        acp_chat_warm: 'answer',
        pane_set_title: 'full',
        attachment_prepare: 'full',
        attachment_save_pasted: 'full',
        acp_chat_start: 'full',
      };
      this.lastCallArgs = a;
      const agents = cmd === 'agent_model_options' ? null : this.agentsCall(node, cmd);
      if (agents) return agents;
      if (!levelOf[cmd]) return { status: 404, body: { error: 'That PC does not do this yet.', code: 'UNKNOWN_ROUTE' } };
      const denial = need(levelOf[cmd]!);
      if (denial) return denial;
      this.farCalls.push({ cmd, args: a });
      const pane = String(a.paneId ?? a.pane_id ?? '');
      if (cmd === 'pane_set_title') {
        const row = list.find((p) => p.id === pane);
        if (!row) return { status: 404, body: { error: 'unknown session', code: 'UNKNOWN_SESSION' } };
        row.title = String(a.title ?? '');
        this.emit();
        return { status: 200, body: row.title || null };
      }
      const state = (this.chatStates[pane] ??= farChatState(pane));
      const feed = this.feedCall(node, cmd, pane, a);
      if (feed) return feed;
      if (cmd === 'agent_model_options') return { status: 200, body: { models: [], live: { id: 'model', options: [{ value: 'sonnet', name: 'Sonnet 5.5', description: null }, { value: 'opus', name: 'Opus 5', description: null }, { value: 'haiku', name: 'Haiku 5', description: null }] } } };
      if (cmd === 'acp_chat_set_config') {
        state.configOptions = (state.configOptions as { id: string }[]).map((o) => (o.id === a.optionId ? { ...o, currentValue: a.value } : o));
      }
      if (cmd === 'acp_chat_set_force_yes') state.forceYes = a.on === true;
      return { status: 200, body: state };
    }
    if (method === 'GET' && segs[1] === 'me') return { status: 200, body: { level, name: d.name, asked: this.asksAt.has(node), you: this.youId } };
    if (method === 'GET' && segs[1] === 'sessions' && segs.length === 2) {
      return { status: 200, body: { sessions: list.map(sessionRowOf) } };
    }
    if (method === 'GET' && segs[1] === 'sessions' && segs[3] === 'transcript') {
      return { status: 200, body: { available: true, reason: null, source: 'file', waitingFor: null, rev: 1, reset: false, items: this.chats[id] ?? [], revision: 1 } };
    }
    if (method === 'GET' && segs[1] === 'sessions' && segs[3] === 'messages') return need('answer') ?? { status: 200, body: { messages: [] } };
    if (method === 'POST' && segs[1] === 'sessions' && segs[3] === 'messages') {
      return need('answer') ?? { status: 200, body: { message: { id: 'm1', text: (body as { text?: string })?.text ?? '', state: 'sent', createdAt: 1, waitingFor: null, error: null } } };
    }
    if (method === 'POST' && segs[1] === 'sessions' && segs[3] === 'interrupt') return need('answer') ?? { status: 200, body: { id, stopped: true } };
    if (method === 'POST' && segs[1] === 'sessions' && segs[3] === 'config') return need('full') ?? { status: 200, body: {} };
    if (method === 'DELETE' && segs[1] === 'sessions' && segs.length === 3) {
      const denial = need('full');
      if (denial) return denial;
      const at = list.findIndex((p) => p.id === id);
      if (at < 0) return { status: 404, body: { error: 'unknown session' } };
      list.splice(at, 1);
      this.emit();
      return { status: 200, body: { ok: true } };
    }
    // The far PC's own agents and the folders it knows (what the New agent page lists).
    if (method === 'GET' && segs[1] === 'agents' && segs.length === 2) {
      return {
        status: 200,
        body: {
          agents: [
            { id: 'claude', label: 'Claude', chat: true, terminal: true },
            { id: 'codex', label: 'Codex', chat: true, terminal: true },
          ],
          terminals: true,
        },
      };
    }
    if (method === 'GET' && segs[1] === 'projects' && segs.length === 2) return { status: 200, body: { projects: [...(this.projectsOf[node] ?? [{ id: 'proj-app', name: 'app', state: 'ready' }]), ...(this.opened[node] ?? [])] } };
    // This PC's own usage (the far PC's `GET /pclink/usage`), when the scenario gives one.
    if (method === 'GET' && segs[1] === 'usage') return this.usageOf[node] ? { status: 200, body: this.usageOf[node] } : { status: 200, body: { rows: [], refreshed_at_ms: 0 } };
    // Browse folders: the places the far PC offers and the folders in each (Full level).
    if (method === 'GET' && segs[1] === 'browse') {
      const denial = need('full');
      if (denial) return denial;
      const tree = this.browseTree[node] ?? { roots: [], dirs: {} };
      const q = new URLSearchParams(path.split('?')[1] ?? '');
      const rootId = q.get('root');
      if (!rootId) return { status: 200, body: { roots: tree.roots } };
      const sub = q.get('sub') ?? '';
      const names = tree.dirs[`${rootId}|${sub}`];
      if (!names) return { status: 404, body: { error: 'That folder is not there.', code: 'NOT_A_FOLDER' } };
      return { status: 200, body: { root: rootId, sub, name: sub.split('/').filter(Boolean).pop() ?? tree.roots.find((r) => r.id === rootId)?.name ?? '', entries: names.map((name) => ({ name })), truncated: false } };
    }
    if (method === 'POST' && segs[1] === 'projects' && segs[2] === 'open') {
      const denial = need('full');
      if (denial) return denial;
      const b = (body ?? {}) as { root?: string; sub?: string };
      if (!b.sub) return { status: 400, body: { error: 'Pick a folder inside it.', code: 'BAD_PATH' } };
      const project = { id: `opened-${b.root}-${b.sub.split('/').join('-')}`, name: b.sub.split('/').pop() ?? '', state: 'folder' };
      (this.opened[node] ??= []).push(project);
      return { status: 200, body: { project } };
    }
    if (method === 'GET' && segs[1] === 'agents' && segs[3] === 'models') return need('full') ?? { status: 200, body: { models: [], live: { id: 'model', options: [{ value: 'sonnet', name: 'Sonnet 5.5', description: null }, { value: 'opus', name: 'Opus 5', description: null }, { value: 'haiku', name: 'Haiku 5', description: null }] } } };
    if (method === 'POST' && segs[1] === 'agents' && segs[2] === 'warm') return need('full') ?? { status: 200, body: { warming: true } };
    if (method === 'POST' && segs[1] === 'agents' && segs[2] === 'start') {
      const denial = need('full');
      if (denial) return denial;
      const b = (body ?? {}) as { agent?: string; lane?: string };
      const newId = `n${list.length + 1}`;
      list.push({ id: newId, agent_type: b.agent ?? 'claude', cwd: '/Users/me/app', status: 'idle', title: 'New chat', ...(b.lane === 'chat' ? { lane: 'acp' as const } : {}) });
      this.emit();
      return { status: 200, body: { pane_id: newId, agent: b.agent ?? 'claude', lane: b.lane ?? 'chat' } };
    }
    // Take the conversation and the work: the far side checks a git bundle out in one of its projects.
    if (method === 'POST' && segs[1] === 'move-work') return need('full') ?? { status: 200, body: { ok: true, branch: (body as { branch?: string })?.branch ?? '', sha: 'f'.repeat(40) } };
    // "Ask <PC> to allow agents": a real card on the far PC. Asking grants nothing; a second ask while one waits is not a second card.
    if (method === 'POST' && segs[1] === 'full-request') {
      if (level === 'full') return { status: 409, body: { error: 'This PC can already work there.', code: 'ALREADY_FULL' } };
      if (this.askFails) return { status: 429, body: { error: 'That PC was asked a moment ago.', code: 'TOO_SOON', retry_after_ms: 120_000 } };
      const already = this.asksAt.has(node);
      this.asksAt.add(node);
      return { status: 202, body: already ? { asked: true, already: true } : { asked: true, id: `full-${this.asksAt.size}` } };
    }
    if (method === 'GET' && segs[1] === 'questions') return { status: 200, body: { questions: (this.questionsOf[node] ?? []).map((q) => ({ ...q })) } };
    if (method === 'POST' && segs[1] === 'questions' && segs[3] === 'answer') {
      const denial = need('answer');
      if (denial) return denial;
      const left = (this.questionsOf[node] ?? []).filter((q) => q.id !== id);
      if (left.length === (this.questionsOf[node] ?? []).length) return { status: 404, body: { code: 'QUESTION_NOT_FOUND', error: 'That question is not waiting any more.' } };
      this.questionsOf[node] = left;
      this.answeredQuestions.push({ node, id, answer: (body ?? {}) as Record<string, unknown> });
      return { status: 200, body: { accepted: true } };
    }
    return { status: 404, body: { error: 'not found' } };
  };
  /** Per device: the agents its registry lists (default: Claude and Codex, both installed). */
  agentsOf: Record<string, FarAgent[]> = {};
  /** Per device: the questions and approvals waiting there (`GET /pclink/questions`). A test changes the list and calls `emitQuestions`. */
  /** The id every far PC in this fake names the caller by (`/pclink/me` `you`). */
  youId = 'link:this-pc';
  questionsOf: Record<string, { id: string; question: string; choices: { id: string; label: string }[]; allow_free_text: boolean; pane_id?: string }[]> = {};
  /** The answers this PC sent to far questions, in order. */
  answeredQuestions: { node: string; id: string; answer: Record<string, unknown> }[] = [];
  /** The far PC says its questions changed (the `questions` frame). */
  emitQuestions(node: string): void {
    this.emitEvent({ node, frame: `event: questions${'\n'}data: {}${'\n'}${'\n'}` });
  }
  /** The files whose bytes reached a far chat (`attachment_save_pasted`): which chat, the name, and the size of the text that carried them. */
  savedFiles: { pane: string; name: string; mime: string; bytes: number }[] = [];
  /** Per far chat: its message box queue (`pane_messages_list`). */
  outboxes: Record<string, Record<string, unknown>[]> = {};
  private nextMessage = 1;
  /** One `app` frame of the far PC's event stream, as the window's own event would arrive. */
  private appFrame(node: string, event: string, payload: unknown): void {
    this.emitEvent({ node, frame: 'event: app\ndata: ' + JSON.stringify({ event, payload }) + '\n\n' });
  }
  /** The far call rows the New agent page reads (`pclink/calls.rs`, `// ---- P2.1 agents/projects ----`): Watch level, the same JSON as the app's own commands. `null`: not one of them. */
  private agentsCall(node: string, cmd: string): { status: number; body: unknown } | null {
    const rows = this.agentsOf[node] ?? DEFAULT_FAR_AGENTS;
    if (cmd === 'agents_list') return { status: 200, body: { agents: rows.map(descriptorOf), dispatchable_ids: rows.map((r) => r.id) } };
    if (cmd === 'agent_lane_get') return { status: 200, body: { labs_enabled: true, agents: rows.map((r) => ({ id: r.id, lane: 'acp', disabled: false })) } };
    if (cmd === 'agent_default_models') return { status: 200, body: {} };
    if (cmd === 'agent_rules_effective') return { status: 200, body: { model: null, mode: null, force_yes: false, force_yes_source: null, notes: null, fences: [] } };
    if (cmd === 'project_recent') {
      const all = [...(this.projectsOf[node] ?? [{ id: 'proj-app', name: 'app', state: 'ready' }]), ...(this.opened[node] ?? [])];
      return { status: 200, body: all.filter((p) => p.state !== 'missing').map((p, i) => ({ path: `remote:${p.id}`, name: p.name, state: p.state, last_used_ms: all.length - i })) };
    }
    // P6.1 (`calls.rs`, `// ---- P6.1 lend ----`): the far PC says what it has installed, and asks the lender back (Full). The grant id is `lg_far_1`.
    if (cmd === 'agents_detect_installed') return { status: 200, body: rows.filter((r) => r.installed !== false).map((r) => ({ id: r.id, displayName: r.label, path: r.id, kind: 'cli' })) };
    if (cmd === 'own_borrow_ask') {
      this.farCalls.push({ cmd, args: this.lastCallArgs });
      return this.levelOf(node) === 'full' ? { status: 200, body: { grantId: 'lg_far_1' } } : { status: 403, body: { error: 'not_allowed', code: 'DEVICE_NOT_ALLOWED' } };
    }
    if (cmd === 'agent_model_options') return { status: 200, body: { terminal: false, default_model: null, models: [], live: { id: 'model', options: [{ value: 'sonnet', name: 'Sonnet 5.5', description: null }, { value: 'opus', name: 'Opus 5', description: null }, { value: 'haiku', name: 'Haiku 5', description: null }] } } };
    return null;
  }
  /** The chat feed rows (P1.7): the feed, Stop, the message box and the chat's switches. `null`: not one of them. */
  private feedCall(node: string, cmd: string, pane: string, a: Record<string, unknown>): { status: number; body: unknown } | null {
    const ok = (body: unknown) => ({ status: 200, body });
    const state = (this.chatStates[pane] ??= farChatState(pane));
    switch (cmd) {
      // P4b: a file's bytes arrive and the far PC keeps them in the chat's project; a chat starts (on a separate copy when asked).
      case 'attachment_save_pasted': {
        const name = String(a.name ?? 'file.bin');
        this.savedFiles.push({ pane, name, mime: String(a.mime ?? ''), bytes: String(a.dataBase64 ?? '').length });
        return ok({ name, path: `/Users/me/app/.potato-workspace/attachments/${name}`, kind: String(a.mime ?? '').startsWith('image/') ? 'image' : 'file', size: 3, mime: a.mime });
      }
      case 'attachment_prepare':
        return ok([]);
      case 'acp_chat_start': {
        const list = this.panes[node] ?? (this.panes[node] = []);
        const newId = `c${list.length + 1}`;
        list.push({ id: newId, agent_type: String(a.agentId ?? 'claude'), cwd: '/Users/me/app', status: 'idle', title: 'New chat', lane: 'acp', ...(a.separateCopy === true ? { copy: true } : {}) });
        this.emit();
        return ok({ pane_id: newId, agent: a.agentId ?? 'claude', lane: 'acp' });
      }
      case 'session_chat_open':
        return ok({ available: true, reason: null, source: 'file', items: this.chats[pane] ?? [], waitingFor: null });
      case 'session_chat_close':
      case 'acp_chat_warm':
      case 'acp_chat_take_back':
        return ok(null);
      case 'chat_earlier':
        return ok({ items: [], more: false });
      case 'chat_picture':
        return { status: 404, body: { error: 'That picture is not there.', code: 'PICTURE_NOT_FOUND' } };
      case 'acp_chat_cancel':
      case 'acp_chat_keep_waiting':
        return ok(true);
      case 'acp_chat_set_auto_allow':
      case 'acp_chat_set_agent_answering':
        return ok(state);
      case 'pane_messages_list':
        return ok(this.outboxes[pane] ?? []);
      case 'pane_message_send': {
        const n = this.nextMessage++;
        const text = String(a.text ?? '');
        const message = { id: 'm' + n, text, createdAt: Date.now(), state: 'sent', waitingFor: null, error: null };
        const queue = (this.outboxes[pane] ??= []);
        queue.push(message);
        // The far PC's reply path: the message shows in the feed and in the box's queue, as frames.
        const item = { kind: 'user', id: 'u-sent-' + n, at: new Date().toISOString(), text };
        (this.chats[pane] ??= []).push(item);
        queueMicrotask(() => {
          this.appFrame(node, 'session-chat-items', { paneId: pane, items: [item], reset: false });
          this.appFrame(node, 'pane-outbox', { paneId: pane, messages: queue });
        });
        return ok(message);
      }
      case 'pane_message_cancel':
      case 'pane_message_hold':
      case 'pane_message_edit': {
        const message = (this.outboxes[pane] ?? []).find((m) => m.id === a.messageId);
        if (!message) return { status: 409, body: { error: 'That message is not waiting any more.', code: 'MESSAGE_NOT_CANCELLABLE' } };
        if (cmd === 'pane_message_cancel') message.state = 'cancelled';
        if (cmd === 'pane_message_edit') message.text = String(a.text ?? '');
        return ok(message);
      }
      default:
        return null;
    }
  }
  /** Per device: the folders its `GET /pclink/projects` lists (default: one called "app"). */
  projectsOf: Record<string, { id: string; name: string; state: string }[]> = {};
  /** Folders opened on a device through "Browse folders" (they join its project list). */
  opened: Record<string, { id: string; name: string; state: string }[]> = {};
  /** Per device: the usage its `GET /pclink/usage` answers. */
  usageOf: Record<string, UsageSnapshot> = {};
  /** Per device: the places it offers to browse, and the folders in each (`<root id>|<sub>` to names). */
  browseTree: Record<string, { roots: { id: string; name: string }[]; dirs: Record<string, string[]> }> = {};
  /** What the far PC lets this PC do. Starts from the device's own `level` in the scenario; a test or the harness can change it. */
  farLevels: Record<string, PcLevel> = {};
  /** PCs this PC asked for Full (a card is waiting there). */
  asksAt = new Set<string>();
  /** The next ask is refused as "asked a moment ago". */
  askFails = false;
  levelOf(node: string): PcLevel {
    return this.farLevels[node] ?? this.view.devices.find((x) => x.node === node)?.level ?? 'watch';
  }
  /** The person at the far PC said yes: that PC lets this PC work on it. */
  grantFull(node: string): void {
    this.farLevels[node] = 'full';
    this.asksAt.delete(node);
  }
  /** Cards on THIS PC (another PC asked to work on it). */
  incomingAsks: FullAsk[] = [];
  private askListeners = new Set<(a: FullAsk) => void>();
  fullAsks = async () => this.incomingAsks.map((a) => ({ ...a }));
  answerFullAsk = async (askId: string, allow: boolean) => {
    const ask = this.incomingAsks.find((a) => a.id === askId);
    this.incomingAsks = this.incomingAsks.filter((a) => a.id !== askId);
    this.answeredAsks.push({ id: askId, allow });
    if (ask && allow) this.view = { ...this.view, devices: this.view.devices.map((x) => (x.node === ask.node ? { ...x, lets_run: true, level: 'full' } : x)) };
    return this.emit();
  };
  answeredAsks: { id: string; allow: boolean }[] = [];
  answerAccountDefault = async (node: string, keep: boolean) => {
    this.view = { ...this.view, devices: this.view.devices.map((x) => (x.node === node ? { ...x, account_card: false, account_default: true, ...(keep ? { lets_run: true, level: 'full' as const } : {}) } : x)) };
    return this.emit();
  };
  onFullAsk = async (cb: (a: FullAsk) => void): Promise<UnlistenFn> => {
    this.askListeners.add(cb);
    return () => this.askListeners.delete(cb);
  };
  /** Another PC asks to work on this one (the card shows). */
  simulateFullAsk(ask: FullAsk): void {
    this.incomingAsks.push(ask);
    for (const cb of this.askListeners) cb(ask);
  }
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
  fake.alsoEmit = (e) => void emit('device://event', e);
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
      case 'devices_pair_pick':
        return v(fake.pairPick(Number(a.id), String(a.pick)));
      case 'devices_rename':
        return v(fake.rename(String(a.node), String(a.name)));
      case 'devices_set_permission':
        return v(fake.setPermission(String(a.node), a.on === true, a.level as DeviceLevel | undefined));
      case 'devices_remove':
        return v(fake.remove(String(a.node)));
      case 'devices_set_route':
        return v(fake.setRoute(a.pref as RoutePref));
      case 'devices_full_asks':
        return v(fake.fullAsks());
      case 'devices_full_ask_answer':
        return v(fake.answerFullAsk(String(a.id), a.allow === true));
      case 'devices_account_default_answer':
        return v(fake.answerAccountDefault(String(a.node), a.keep === true));
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
