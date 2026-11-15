// "Tools are out of date": agents whose MCP connection was started with another tool list than this app's.
// Rust side: src-tauri/src/mcp_drift.rs and commands/mcp.rs. Field names are camelCase like the other views.
import { invoke } from '@tauri-apps/api/core';

/** One agent (or program) running an out-of-date tool list. `paneId` is null for a program the app cannot place. */
export interface ToolsDrift {
  paneId: string | null;
  agentCatalog: string;
  appCatalog: string;
  /** The app can restart this one itself (a chat). Otherwise the person closes and opens the agent again. */
  canReconnect: boolean;
}

const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Every connection with an out-of-date tool list. Empty outside the desktop app. */
export function mcpToolsDrift(): Promise<ToolsDrift[]> {
  if (!inTauri()) return Promise.resolve([]);
  return invoke<ToolsDrift[] | null | undefined>('mcp_tools_drift').then((rows) => (Array.isArray(rows) ? rows : []));
}

/** Restart this chat's agent so it starts the app's own tools. Rejects with `CODE: sentence`. */
export function mcpReconnect(paneId: string): Promise<void> {
  return invoke<void>('mcp_reconnect', { paneId });
}
