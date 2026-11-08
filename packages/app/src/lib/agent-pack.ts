// "Add Potato Workspace to your agents": skills + Potato Workspace's own MCP entry, written into each agent.
// Wrappers over the `agent_pack_*` Tauri commands (src-tauri/src/commands/agent_pack.rs).
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

export type FileKind = 'add' | 'update' | 'replace' | 'unchanged';
export type StepStatus = 'ready' | 'unchanged' | 'skipped' | 'error';

export interface SkillsStep {
  status: StepStatus;
  path: string;
  shared_with: string[];
  files: { name: string; kind: FileKind }[];
  reason: string | null;
  written: boolean;
}

export interface McpStep {
  status: StepStatus;
  path: string;
  format: string;
  shared_with: string[];
  change: FileKind;
  reason: string | null;
  diff: string;
  written: boolean;
  backup: string | null;
}

export interface PackAgent {
  id: string;
  label: string;
  installed: boolean;
  skills: SkillsStep | null;
  mcp: McpStep | null;
}

/** plan.rs `Unsupported`: an agent the backend cannot set up yet. `reason` is the backend's plain-English why; older builds send none, so the UI falls back to a generic one. */
export interface PackUnsupported {
  id: string;
  label: string;
  installed: boolean;
  reason?: string;
}

/** custom.rs Inspection: what Potato Workspace found in a settings file the user picked. Nothing is written yet. */
export interface PackInspection {
  path: string;
  format: 'json' | 'toml' | 'yaml' | string;
  /** Dotted path of the server list, e.g. mcpServers. */
  key_path: string;
  /** The list is not in the file yet and would be created (JSON only). */
  creates_list: boolean;
  /** Plain-English description of the entry shape. */
  shape: string;
  /** The exact entry that would be added. */
  entry: Record<string, unknown>;
  /** An entry for Potato Workspace is already there; it is left unchanged. */
  already_present: boolean;
}

/** custom.rs CustomHost: a settings file the user chose for an agent. */
export interface CustomHostInfo {
  id: string;
  name: string;
  config_path: string;
  format: string;
  key_path: string;
  skills_dir?: string | null;
}

export interface SaveCustomArgs {
  /** A listed agent's id; leave out for an agent Potato Workspace doesn't know. */
  agent_id?: string;
  /** The display name of an unknown agent. */
  name?: string;
  path: string;
  skills_dir?: string;
}

export interface PackReport {
  dry_run: boolean;
  agents: PackAgent[];
  unsupported: PackUnsupported[];
  /** Settings files the user chose (Forget removes one). Older builds send none. */
  custom?: CustomHostInfo[];
  /** Files and config entries an Undo would put back. */
  recorded: number;
}

export interface UndoReport {
  restored: string[];
  removed: string[];
  skipped: { path: string; reason: string }[];
  recorded: number;
}

export interface AgentPackApi {
  preview: () => Promise<PackReport>;
  apply: () => Promise<PackReport>;
  undo: () => Promise<UndoReport>;
  /** Read a settings file the user picked and say what would be added where. Writes nothing. */
  inspect: (path: string) => Promise<PackInspection>;
  saveCustom: (args: SaveCustomArgs) => Promise<CustomHostInfo>;
  forgetCustom: (id: string) => Promise<void>;
  /** The system file / folder picker; null when the user cancels. */
  pickFile: () => Promise<string | null>;
  pickFolder: () => Promise<string | null>;
}

export const agentPackApi: AgentPackApi = {
  preview: () => invoke<PackReport>('agent_pack_preview'),
  apply: () => invoke<PackReport>('agent_pack_apply'),
  undo: () => invoke<UndoReport>('agent_pack_undo'),
  inspect: (path) => invoke<PackInspection>('agent_pack_inspect', { path }),
  saveCustom: (args) =>
    invoke<CustomHostInfo>('agent_pack_custom_save', { agentId: args.agent_id ?? null, name: args.name ?? null, path: args.path, skillsDir: args.skills_dir ?? null }),
  forgetCustom: async (id) => {
    await invoke('agent_pack_custom_forget', { id });
  },
  pickFile: async () => {
    const picked = await openDialog({ directory: false, multiple: false });
    return typeof picked === 'string' ? picked : null;
  },
  pickFolder: async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    return typeof picked === 'string' ? picked : null;
  },
};

/** One row per set of agents that share the same folders: OpenCode and OpenCode (API) read one file. */
export interface PackRow {
  key: string;
  /** Agent ids that share this row. */
  ids: string[];
  labels: string[];
  installed: boolean;
  skills: SkillsStep | null;
  mcp: McpStep | null;
}

export function groupAgents(agents: PackAgent[]): PackRow[] {
  const rows: PackRow[] = [];
  for (const a of agents) {
    const key = `${a.skills?.path ?? ''}|${a.mcp?.path ?? ''}`;
    const row = rows.find((r) => r.key === key);
    if (row) {
      row.labels.push(a.label);
      row.ids.push(a.id);
      row.installed ||= a.installed;
    } else {
      rows.push({ key, ids: [a.id], labels: [a.label], installed: a.installed, skills: a.skills, mcp: a.mcp });
    }
  }
  return rows;
}

/** Rows worth showing: installed ones, or ones with something to do. */
export function visibleRows(rows: PackRow[]): PackRow[] {
  return rows.filter((r) => r.installed || r.skills?.status === 'ready' || r.mcp?.status === 'ready');
}

export function pendingCount(rows: PackRow[]): number {
  return rows.filter((r) => r.skills?.status === 'ready' || r.mcp?.status === 'ready').length;
}
