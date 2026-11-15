// Why "Go back to here" is not possible right now, in one word the page turns into one plain sentence.
import { folderKey, type Mark } from './lanes-model';

export type Refusal = 'running' | 'open' | 'gone' | 'tooBig' | 'off' | 'folder' | 'other';

/** A live chat, as far as the page needs to know. */
export interface PaneLite {
  id: string;
  cwd: string | null;
  name: string;
  status: string;
}

function inside(child: string, parent: string): boolean {
  const c = folderKey(child);
  const p = folderKey(parent);
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

/** The chats that work in this folder, in a folder inside it, or in a folder it sits inside (a worktree). */
export function panesInFolder(panes: readonly PaneLite[], project: string): PaneLite[] {
  return panes.filter((p) => !!p.cwd && (inside(p.cwd, project) || inside(project, p.cwd)));
}

/** The backend's sentence (Rust `CheckpointError`) as a reason. Only our own fixed sentences are matched. */
export function refusalFromMessage(message: string): Refusal {
  const m = message.toLowerCase();
  if (m.includes('too big')) return 'tooBig';
  if (m.includes('turned off')) return 'off';
  if (m.includes('folder is gone') || m.includes("folder doesn't exist")) return 'folder';
  if (m.includes('no longer exists')) return 'gone';
  if (m.includes('run is still open')) return 'open';
  if (m.includes('is working') || m.includes('interrupt')) return 'running';
  return 'other';
}

/** The first reason that stops a go back, or null when it may go ahead. */
export function refusalOf(mark: Mark, panes: readonly PaneLite[], backError: string | null): Refusal | null {
  if (mark.folderGone) return 'folder';
  if (mark.faded) return 'gone';
  if (panesInFolder(panes, mark.row.project).some((p) => p.status === 'running')) return 'running';
  if (backError) return refusalFromMessage(backError);
  return null;
}
