// Panes across three project folders for the sidebar scenarios: one needs you, one working, a pinned one, an idle
// one that ended in an error, and a helper under its parent.
import type { PaneInfo } from '../lib/tauri-types';

const now = Date.now();
const mk = (id: string, agent: string, status: PaneInfo['status'], cwd: string, title: string, minutesAgo: number, extra: Partial<PaneInfo> = {}): PaneInfo =>
  ({
    id,
    agent_type: agent,
    pid: 1000 + minutesAgo,
    status,
    created_at: now - minutesAgo * 60_000,
    last_output_at: now - 5_000,
    cwd,
    cols: 120,
    rows: 32,
    title,
    ...extra,
  }) as PaneInfo;

const WORK = 'C:/Users/dev/work';

export const SIDEBAR_PANES: PaneInfo[] = [
  mk('sb-login', 'claude', 'waiting_input', `${WORK}/potato-workspace`, 'Fix login redirect', 2),
  mk('sb-rework', 'codex', 'running', `${WORK}/potato-workspace`, 'Sidebar rework', 8),
  mk('sb-notes', 'claude', 'running', `${WORK}/potato-workspace`, 'Write release notes', 1),
  mk('sb-helper', 'claude', 'running', `${WORK}/potato-workspace`, 'Check the tests', 3, { parent_pane_id: 'sb-rework' } as Partial<PaneInfo>),
  mk('sb-review', 'opencode', 'idle', `${WORK}/potato-site`, 'Review PR 265', 60),
  mk('sb-docs', 'claude', 'error', `${WORK}/potato-site`, 'Fix flaky docs build', 25),
  mk('sb-plan', 'claude', 'idle', `${WORK}/acp-lab`, 'Night plan', 180),
  mk('sb-scratch', 'powershell', 'idle', `${WORK}/scratch`, 'Scratch shell', 300),
];

// What the project cards read: the branch of the folder an agent works in, and for one agent a separate copy with
// its change counts and pull request (the same shapes the Changes panel reads).
const BRANCHES: Record<string, string> = { 'sb-login': 'main', 'sb-notes': 'main', 'sb-review': 'main', 'sb-docs': 'main' };
export const sidebarBranch = (paneId: string): string | null => BRANCHES[paneId] ?? null;
export const sidebarWorktree = (paneId: string) =>
  paneId === 'sb-rework'
    ? {
        handle: 'w-rework',
        branch: 'feat/sidebar-rework',
        base: 'main',
        repo: `${WORK}/potato-workspace`,
        path: `${WORK}/potato-workspace-w-rework`,
        exists: true,
        state: 'active',
        summary: { files_changed: 9, additions: 124, deletions: 18 },
        pr: { number: 212, url: 'https://example.invalid/pr/212', draft: false, base: 'main', created_at_ms: now, checks: { state: 'passing', items: [], checked_at_ms: now } },
      }
    : null;
