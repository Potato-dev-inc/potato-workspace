// What the mocked backend answers for the first-run welcome (harness scenarios only).
import { emit } from '@tauri-apps/api/event';
import cases from '../components/simple/folder-cases.json';
import { folderVerdict, type KnownDirs } from '../components/simple/folder-guard';
import type { Look, StepId } from '../components/firstrun/model';
import type { RecentProject } from '../lib/ship-api';

export interface FirstRunScenario {
  /** Where the welcome starts (the saved step). Default: the first. */
  step?: StepId;
  /** The look already chosen (a reopen). */
  look?: Look;
  /** Folder and agent saved from an earlier visit, so a later step can show its content. */
  project?: string;
  agent?: string;
  /** Potato Workspace is already in the agents' config files. */
  connected?: boolean;
}

const KNOWN = cases.known as KnownDirs;
const now = Date.now();
/** Whether the mocked agent pack has been applied (the welcome's Connect step). */
let connected = false;

/** Recent projects with one folder the guard refuses (Documents). */
export const FIRST_RUN_RECENT: RecentProject[] = [
  { path: 'D:\\code\\shop', name: 'shop', state: 'repo', last_used_ms: now - 60_000 },
  // A subfolder of a listed repository: not offered.
  { path: 'D:\\code\\shop\\packages\\app', name: 'app', state: 'repo', last_used_ms: now - 120_000 },
  { path: 'D:\\code\\landing-page', name: 'landing-page', state: 'folder', last_used_ms: now - 3_600_000 },
  { path: 'C:\\Users\\Ana\\Documents', name: 'Documents', state: 'folder', last_used_ms: now - 86_400_000 },
  { path: 'D:\\code\\old-experiment', name: 'old-experiment', state: 'missing', last_used_ms: now - 9 * 86_400_000 },
];

/** The agents the welcome finds: Claude and Codex are on this PC, Cursor and OpenCode are not. */
const AGENTS = [
  { id: 'claude', label: 'Claude', state: 'unchecked', installed: true, version: '2.1.4 (Claude Code)', reason: 'Installed.', install_hint: null, login_hint: null, can_test: true },
  { id: 'codex', label: 'Codex', state: 'unchecked', installed: true, version: 'codex-cli 0.162.1', reason: 'Installed.', install_hint: null, login_hint: null, can_test: true },
  { id: 'cursor_agent', label: 'Cursor', state: 'not_installed', installed: false, version: null, reason: 'Not installed on this computer.', install_hint: 'winget install Cursor.Agent', login_hint: null, can_test: false },
  { id: 'opencode', label: 'OpenCode', state: 'not_installed', installed: false, version: null, reason: 'Not installed on this computer.', install_hint: 'winget install SST.opencode', login_hint: null, can_test: false },
];

/** The plan of the agent pack for Claude Code and Codex, with the connection added or not. */
function packReport(done: boolean, recorded: number) {
  const agent = (id: string, label: string, dir: string, file: string) => ({
    id,
    label,
    installed: true,
    skills: { status: done ? 'unchanged' : 'ready', path: `C:/Users/dev/${dir}/skills`, shared_with: [], files: [{ name: 'delegate', kind: done ? 'unchanged' : 'add' }, { name: 'review', kind: done ? 'unchanged' : 'add' }], reason: null, written: false },
    mcp: { status: done ? 'unchanged' : 'ready', path: `C:/Users/dev/${dir}/${file}`, format: 'json', shared_with: [], change: done ? 'unchanged' : id === 'codex' ? 'update' : 'add', reason: null, diff: id === 'codex' ? '- command = "C:\\old\\potato-workspace-mcp.exe"\n+ command = "C:\\dev\\mcp.exe"' : '', written: false, backup: null },
  });
  return { dry_run: !done, agents: [agent('claude', 'Claude Code', '.claude', '.claude.json'), agent('codex', 'Codex', '.codex', 'config.toml')], unsupported: [], custom: [], recorded };
}

/** The settings the mocked store starts with, besides the theme. */
export function firstRunStore(sc: FirstRunScenario | undefined): Record<string, unknown> {
  if (!sc) return { onboarding_done: true };
  return {
    ...(sc.look ? { simple_mode: sc.look !== 'code' } : {}),
    ...(sc.project ? { onboarding_project: sc.project } : {}),
    ...(sc.agent ? { onboarding_agent: sc.agent } : {}),
  };
}

export function firstRunMock(sc: FirstRunScenario | undefined, cmd: string, a: Record<string, unknown>): { handled: boolean; value?: unknown } {
  if (!sc) return { handled: false };
  const yes = (value: unknown) => ({ handled: true, value });
  switch (cmd) {
    case 'first_run_state':
      return yes({ show: true, auto: false, step: sc.step ?? null });
    case 'plain_check_folder': {
      // The repository is big: the old copy check refused it. The welcome now lets it through.
      if (String(a.path ?? '') === 'D:\\code\\shop') return yes({ ok: false, code: 'FOLDER_TOO_BIG', message: 'This folder is too big to copy.' });
      const verdict = folderVerdict(String(a.path ?? ''), KNOWN);
      return yes(verdict === 'ok' ? { ok: true } : { ok: false, code: 'FOLDER_TOO_BROAD', message: verdict });
    }
    case 'project_recent':
      return yes(FIRST_RUN_RECENT);
    case 'agents_health':
      return yes({ agents: AGENTS });
    case 'agent_pack_preview':
      return yes(packReport(connected || !!sc.connected, connected ? 2 : 0));
    case 'agent_pack_apply':
      connected = true;
      return yes(packReport(true, 2));
    case 'agent_pack_undo':
      connected = false;
      return yes({ restored: [], removed: ['a', 'b'], skipped: [], recorded: 0 });
    case 'standby_get_status':
      return yes({ enabled: false, config: { preload: { enabled: false, providers: {} }, backends: {}, max_total: 3, recent_projects: 2, recent_hours: 6, idle_timeout_secs: 1200 }, counts: { total: 0, ready: 0, starting: 0 }, standbys: [], blocked: [], recent: [] });
    case 'standby_set_config':
      return yes(null);
    case 'new_pane':
      // A warm agent is ready at once: say so, as the real app does.
      window.setTimeout(() => void emit('pane://spawn-stage', { agent_id: a.agentId, pane_id: 'pane-new-1', stage: 'ready', warm: true }), 50);
      return yes('pane-new-1');
    case 'write_pane_input':
      return yes(null);
    default:
      return { handled: false };
  }
}
