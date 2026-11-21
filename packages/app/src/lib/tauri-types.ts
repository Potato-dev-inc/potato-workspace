// Payload/result shapes exchanged with the Rust side over Tauri invoke/events.

import type { PanePlace } from './wsl';

export type PaneInfo = {
  id: string;
  agent_type: string;
  pid: number;
  status: 'running' | 'waiting_input' | 'idle' | 'error';
  created_at: number;
  last_output_at: number | null;
  cwd: string;
  cols: number;
  rows: number;
  /** A phone viewing this pane holds its size (desktop windows show a notice). */
  viewer_held?: boolean;
  /** The agent reprints its whole conversation on every resize: viewers wipe scrollback at each one. */
  reprints_on_resize?: boolean;
  /** Account id the agent runs under (absent = the CLI's own login) and its label for the header. */
  account?: string | null;
  account_label?: string | null;
  /** Human title (user name, else derived from the first task); absent until the pane has one. */
  title?: string | null;
  /** The pane of the agent that started this one over MCP (a helper); display-only, absent for the person's own panes. */
  parent_pane_id?: string | null;
  /** `minion` | `spin_off`: what the agent that started this pane made it (Two types). Absent: the person's own chat, or One type. */
  started_as?: string | null;
  /** Who started this pane over MCP and what for: the calling host ("Claude Code") and the first line of the task. Display-only. */
  origin?: { host?: string | null; task?: string | null } | null;
  /** Where a Linux (WSL) pane runs; absent for a Windows pane. Display only. */
  place?: PanePlace;
  /** `acp`: a chat session over the Agent Client Protocol (no terminal behind the pane). Absent for a terminal pane. */
  lane?: 'acp';
  /** This chat is a standby seat's own chat (the seat's id). It is drawn as the seat's row under its owner, never as an agent. */
  standby_seat?: string | null;
};

export type TerminalSnapshotEvent = { pane_id: string; snapshot: string };
export type TerminalDataEvent = {
  pane_id: string;
  data: number[];
  /** Where this chunk starts in the pane's byte stream (see `PaneScreenReplay.offset`). */
  offset?: number;
};
export type PaneStatusEvent = { pane_id: string; status: PaneInfo['status'] };
export type PaneExitEvent = { pane_id: string };
export type PanesChangedEvent = { changed: boolean };
/** A phone lease changed a pane's PTY size; ordered with `terminal-data` (desktop owner windows follow it). */
export type PtyResizedEvent = { pane_id: string; cols: number; rows: number; offset?: number };
export type PaneDetachEvent = { pane_id: string; title?: string; cols?: number; rows?: number };
export type PaneReattachEvent = { pane_id: string };

export interface WorkerLaunchConfig {
  agent_type: string;
  cwd?: string | null;
  pane_id?: string | null;
  cols: number;
  rows: number;
  force_new: boolean;
}

export interface EnsureMcpResult {
  installed: boolean;
  changed: boolean;
  backend: string;
  message: string;
}

export interface McpBackendStatus {
  backend: string;
  label: string;
  installed: boolean;
  usesNpm: boolean;
  configPath: string;
  message: string;
}

export interface McpStatusReport {
  bridgeReachable: boolean;
  bridgeUrl: string | null;
  bridgeVersion: string | null;
  portFileExists: boolean;
  portFilePath: string;
  nodeAvailable: boolean;
  npmAvailable: boolean;
  npmPackageVersion: string | null;
  launchCommand: string;
  backends: McpBackendStatus[];
  overallReady: boolean;
  repairResults: EnsureMcpResult[];
}

export interface CoordinationStorageInfo {
  scope: 'project' | 'global_fallback' | string;
  project_path: string | null;
  storage_dir: string;
  event_log_path: string;
  event_count: number;
  task_count: number;
  lock_count: number;
  exists: boolean;
}

export interface OpenCodeKeyProfileInfo {
  id: string;
  label: string;
  configured: boolean;
}

export interface OpenCodeKeyStatus {
  active_profile: string;
  profiles: OpenCodeKeyProfileInfo[];
  key_automation_mode: string;
  restart_pane_on_rotate: boolean;
}

export interface RotateOpenCodeKeyResult {
  ok: boolean;
  active_profile: string;
  profiles: OpenCodeKeyProfileInfo[];
  restarted_panes: string[];
}

export interface AppInstallInfo {
  version: string;
  isPackaged: boolean;
  platform: string;
  uninstallAvailable: boolean;
  uninstallInstructions: string;
  dataDir: string;
}

/** Warm standby pool settings (`standby-pool.json`; see `src-tauri/src/standby`). */
export interface StandbyBackendToggle {
  visible: boolean;
  headless: boolean;
}

/** Settings > Preload: warm visible workers per provider in the default project folder. */
export interface PreloadConfig {
  enabled: boolean;
  /** agent id -> warm workers wanted (0-2); missing or 0 = not warmed. */
  providers: Record<string, number>;
}

export interface StandbyConfig {
  preload: PreloadConfig;
  /** Legacy master switch for the hand-edited headless toggles in `backends`. */
  enabled: boolean;
  backends: Record<string, StandbyBackendToggle>;
  max_total: number;
  recent_projects: number;
  recent_hours: number;
  idle_timeout_secs: number;
}

export interface StandbyView {
  id: number;
  agent_type: string;
  project: string;
  headless: boolean;
  read_only: boolean;
  model: string | null;
  state: 'starting' | 'ready';
  health: string;
  age_ms: number;
  ready_for_ms: number | null;
  idle_expires_in_ms: number | null;
  pane_id?: string;
}

export interface StandbyBlockedView {
  key: string;
  reason: string;
  fails: number;
  retry_in_ms: number;
  cold: boolean;
}

export interface StandbyAgentBlockedView {
  agent_type: string;
  reason: string;
  /** Plain words to show after "<Agent> couldn't stay warm: ". */
  message: string;
  fails: number;
  retry_in_ms: number;
  cold: boolean;
}

/** Why Preload warms where it does: the last run, the pane you last focused, or a setting. */
export interface StandbyFollowing {
  project: string;
  why: 'run' | 'focus' | 'setting' | 'registry';
  not_warmed: { agent_type: string; reason: 'needs_trust' }[];
}

export interface StandbyStatus {
  enabled: boolean;
  config: StandbyConfig;
  counts: { total: number; ready: number; starting: number };
  standbys: StandbyView[];
  blocked: StandbyBlockedView[];
  agents_blocked?: StandbyAgentBlockedView[];
  /** The folder warm agents are started in and why (older builds do not send it). */
  following?: StandbyFollowing | null;
  recent: { key: string; age_ms: number }[];
  stats: {
    spawned: number;
    spawn_failed: number;
    claimed: number;
    missed: number;
    discarded: number;
    expired: number;
    abandoned: number;
  };
  supported: { agent_type: string; visible: boolean; headless: boolean; experimental: boolean }[];
}

export type TunnelMode = 'quick' | 'named' | 'custom' | 'stable' | 'open_tunnel';

/** Saved tunnel setting as the UI may see it: never the token, only whether one is stored. */
export interface TunnelConfigView {
  mode: TunnelMode;
  hostname: string | null;
  /** `stable` mode: the Worker address. */
  url: string | null;
  has_token: boolean;
  /** `stable` mode: whether a shared secret is stored (never the secret itself). */
  has_secret?: boolean;
}

export interface TunnelStatus {
  /** Effective mode: `env` when POTATO_WORKSPACE_PUBLIC_URL overrides the saved setting. */
  mode: TunnelMode | 'env';
  public_url: string | null;
  state: 'stopped' | 'starting' | 'running' | 'error';
  error: string | null;
  config: TunnelConfigView;
  /** `stable` mode: the Worker, the quick-tunnel address behind it and whether they are linked. */
  stable?: TunnelStableStatus | null;
  /** Only on the answer to a save that made the secret or asked to show it. */
  secret_once?: string | null;
  /** Set when "Make a new secret" was not done because the Worker could not forget the old one (why, in plain words). */
  secret_not_reset?: string | null;
  /** Why no quick address is coming (the screen has the words for each). */
  problem?: 'rate_limited' | 'slow_start' | 'too_soon' | null;
  /** What the app is really doing right now (a real step with a counter); absent when nothing is in progress. */
  step?: TunnelStep | null;
  /** The last few real events (oldest first) for the Details list. Closed codes only; a host is a bare host name. */
  events?: TunnelEvent[];
  /** With a problem: seconds until the tunnel may be started again. */
  retry_in_secs?: number | null;
  /** The port the phone server really listens on (what an own domain must point at); null when it is not running. */
  local_port?: number | null;
  /** The port the person chose for the phone server (used from the next start); null or absent: automatic. */
  chosen_port?: number | null;
  /** `moved`: the usual port was busy; `not_running`: the phone server could not start. */
  port_problem?: 'moved' | 'not_running' | null;
  /** "Temporary link": phones get the plain quick address and the Worker is left out (it stays saved and linked). */
  link_temporary?: boolean;
  /** Which link is on: permanent (the Worker), temporary (quick address) or domain (the person's own address). */
  link_mode?: 'permanent' | 'temporary' | 'domain';
  /** How the chosen link carries traffic: book (the address only says where this PC is) or direct (the address carries it). */
  link_route?: 'book' | 'direct';
  /** The person's own https address, kept saved while another link is on. */
  own_domain?: string | null;
  /** The own address passed a Check made by the app, so phones are given it. False or absent: "Not checked yet". */
  own_domain_verified?: boolean;
  /** "My domain" + Address book: where this PC stands with the person's Worker. Absent for every other link. */
  book?: TunnelBookStatus | null;
}

/** "My domain" + Address book as the backend reports it. */
export interface TunnelBookStatus {
  domain: string;
  /** This PC runs a quick tunnel. False for a named, custom or fixed-address tunnel: there is no quick address to register. */
  supported: boolean;
  /** A quick address exists to register. */
  has_address: boolean;
  /** The name has proven it is the Worker. False: this PC sends it nothing yet (a typo or a look-alike never gets a key). */
  armed?: boolean;
  link: 'waiting' | 'linking' | 'linked' | 'failed';
  /** Why registering failed: secret_mismatch | worker_gone | over_quota | offline | worker_too_old (the name is not an Address book Worker). */
  reason?: 'secret_mismatch' | 'worker_gone' | 'over_quota' | 'offline' | 'worker_too_old' | null;
}

/** The Worker files for "My domain" + Address book: the source and a settings file with the name and the key's hash filled in. */
export interface DomainBookFiles {
  host: string;
  worker_js: string;
  wrangler_toml: string;
}

export interface TunnelEvent {
  at_ms: number;
  code: 'phone_server_up' | 'tunnel_started' | 'tunnel_stopped' | 'tunnel_off' | 'address' | 'relay_linked' | 'relay_failed' | 'book_linked' | 'book_failed' | 'outside_ok' | 'outside_failed';
  host?: string | null;
  reason?: string | null;
}

export interface TunnelStep {
  code: 'starting_phone_server' | 'starting_tunnel' | 'waiting_for_address' | 'address_ready' | 'registering' | 'checking_outside' | 'connected' | 'not_reached' | 'tunnel_off';
  /** Seconds this step has lasted when the status was read. */
  elapsed_secs: number;
  /** Registering only: the failed tries so far, and the seconds until the next one. */
  retry?: number | null;
  next_in_secs?: number | null;
}

export interface TunnelStableStatus {
  worker_url: string;
  quick_url: string | null;
  link: 'waiting' | 'linking' | 'linked' | 'failed';
  error: string | null;
  /** The Worker holds another secret than the one saved here. */
  secret_mismatch?: boolean;
  /** Why the link failed: worker_gone (removed from Cloudflare) | over_quota (free daily limit) | offline | secret_mismatch | worker_too_old. */
  reason?: 'worker_gone' | 'over_quota' | 'offline' | 'secret_mismatch' | 'worker_too_old' | null;
}

export type TunnelConfigInput =
  | { mode: 'quick' }
  | { mode: 'named'; hostname: string; token?: string | null }
  | { mode: 'custom'; url: string }
  | { mode: 'open_tunnel' }
  /** Switch to the automatic address and drop the remembered Worker address and secret. */
  | { mode: 'forget_worker' }
  | {
      mode: 'stable';
      worker_url: string;
      /** A secret the person chose; empty or null keeps the stored one (or makes one). */
      secret?: string | null;
      secret_action?: 'keep' | 'regenerate' | 'show';
      /** "Make a new secret" only: go ahead although the Worker could not forget the old one. */
      confirm_strand?: boolean;
    };

export interface TunnelConnectionTest {
  ok: boolean;
  url: string;
  http_status: number | null;
  latency_ms: number;
  message: string;
  /** Own address Check: why it did or did not reach this PC. */
  reason?:
    | 'reached'
    | 'not_this_pc'
    | 'dns'
    | 'timeout'
    | 'unreachable'
    | 'redirect'
    | 'bad_gateway'
    | 'other_http'
    /** Address book only: */
    | 'no_quick_tunnel'
    | 'no_address'
    | 'no_worker'
    | 'not_linked'
    | 'stale'
    | 'tunnel_down'
    | 'over_quota'
    | 'busy'
    /** Newer Address book checks (the backend may send more fields next to these; read them defensively): */
    | 'is_direct'
    | 'other_key'
    | 'unconfigured'
    | 'dns_taken'
    | 'zone_missing'
    | null;
  /** dns_taken: the record that holds the name (type and target), when the backend says. */
  dns_type?: string | null;
  dns_target?: string | null;
}

/** One file of the diagnostic zip (Settings > General > Save a diagnostic file). */
export interface DiagnosticEntry {
  path: string;
  /** Plain words for the list. */
  label: string;
  bytes: number;
}

export interface DiagnosticPreview {
  files: DiagnosticEntry[];
  totalBytes: number;
}

export interface PerfStat {
  count: number;
  medianMs: number | null;
  lastMs: number | null;
}

/** "Speed on this PC": worked out from the app's own log file. */
export interface PerfSummary {
  appStart: PerfStat;
  chatWarm: PerfStat;
  chatCold: PerfStat;
  handshake: PerfStat;
  /** From sending a message to the first sign of an answer. */
  firstReply: PerfStat;
  /** One run of "Check my setup". */
  setupCheck: PerfStat;
  /** Chat starts that used a session kept ready ahead of time, and those that did not. */
  warmHits: number;
  warmMisses: number;
  /** The steps of the last app start, in order. */
  startupSteps: { name: string; stepMs: number }[];
  startupTotalMs: number | null;
}

/** What a project may use in a day (null = no limit). */
export interface ProjectBudgetLimits {
  turnsPerDay: number | null;
  minutesPerDay: number | null;
  planPercent: number | null;
}

/** Where a chat's project stands today; null from the command when the project has no limits. */
export interface ProjectBudgetStatus {
  limits: ProjectBudgetLimits;
  usedTurns: number;
  usedMinutes: number;
  planPercent: number | null;
  reached: 'turns' | 'minutes' | 'plan' | null;
}

/** The quiet "try a different model" line after a turn. */
export interface RightSizeSuggestion {
  kind: 'smaller' | 'stronger';
  fromName: string;
  toValue: string;
  toName: string;
}

export interface LastRun {
  closedUnexpectedly: boolean;
  crashedAtMs: number | null;
}

export interface DiagnosticSaved {
  path: string;
  files: number;
  bytes: number;
}
