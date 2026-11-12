// Settings > Danger zone: the commands behind "Reset settings" and "Uninstall everything" (Rust: uninstall::commands).
// The block takes an `UninstallApi`, so tests pass a fake and nothing real is ever called from a test.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface UninstallItem {
  label: string;
  path: string | null;
  bytes: number;
  files: number;
}

export interface UninstallGroup {
  id: string;
  title: string;
  detail: string;
  /** Short size shown at the right: "412 MB", "14 keys". */
  size: string;
  bytes: number;
  files: number;
  connections: number;
  defaultOn: boolean;
  keepReason: string | null;
  items: UninstallItem[];
}

export interface UninstallCant {
  title: string;
  how: string;
}

export interface UninstallPlan {
  groups: UninstallGroup[];
  cant: UninstallCant[];
  profiles: string[];
  totalFiles: number;
  connections: number;
  keys: number;
  chatsZipName: string;
  keepChatsDefault: boolean;
}

export interface UninstallSelection {
  groups: string[];
  keepChats: boolean;
}

export type UninstallStepState = 'running' | 'done' | 'skipped' | 'failed';

export interface UninstallProgress {
  step: string;
  label: string;
  detail: string;
  state: UninstallStepState;
  index: number;
  total: number;
}

export interface UninstallAllowed {
  allowed: boolean;
  reason: string | null;
}

export interface UninstallApi {
  allowed: () => Promise<UninstallAllowed>;
  plan: () => Promise<UninstallPlan>;
  run: (selection: UninstallSelection) => Promise<void>;
  /** Subscribe to `uninstall://progress`. Resolves to the unsubscribe function. */
  onProgress: (listener: (progress: UninstallProgress) => void) => Promise<() => void>;
  resetSettings: () => Promise<void>;
}

export const PROGRESS_EVENT = 'uninstall://progress';

export const realUninstallApi: UninstallApi = {
  allowed: () => invoke<UninstallAllowed>('uninstall_allowed'),
  plan: () => invoke<UninstallPlan>('uninstall_plan'),
  run: (selection) => invoke<void>('uninstall_run', { selection }),
  onProgress: async (listener) => listen<UninstallProgress>(PROGRESS_EVENT, (event) => listener(event.payload)),
  resetSettings: async () => {
    await invoke('settings_reset');
  },
};

/** The ticks a plan starts with (founder answers D5, D6: chats are not kept by default, Store programs stay). */
export function defaultSelection(plan: UninstallPlan): UninstallSelection {
  return { groups: plan.groups.filter((g) => g.defaultOn).map((g) => g.id), keepChats: plan.keepChatsDefault };
}

const number = (n: number) => n.toLocaleString('en-US');

/** "Removes 2,314 files and 9 agent connections." for what is ticked. */
export function summaryLine(plan: UninstallPlan, selection: UninstallSelection): string {
  const ticked = plan.groups.filter((g) => selection.groups.includes(g.id));
  const files = ticked.reduce((n, g) => n + g.files, 0);
  const connections = ticked.reduce((n, g) => n + g.connections, 0);
  const parts: string[] = [];
  if (files > 0) parts.push(`${number(files)} file${files === 1 ? '' : 's'}`);
  if (connections > 0) parts.push(`${number(connections)} agent connection${connections === 1 ? '' : 's'}`);
  return parts.length > 0 ? `Removes ${parts.join(' and ')}.` : 'Removes what you ticked.';
}
