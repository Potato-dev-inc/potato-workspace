import { useEffect, useMemo, useState } from 'react';
import { cockpitApi, worktreeApiFor, type WorktreeApi, type WorktreeItem } from '../../lib/cockpit-api';
import { useHost } from '../../lib/host/context';

/** The copy calls of the place this screen shows (this PC, or another over the PC link), for the chat `paneId`. */
export function useWorktreeApi(paneId: string): WorktreeApi {
  const host = useHost();
  return useMemo(() => worktreeApiFor(host, paneId), [host, paneId]);
}

/**
 * The git worktree a pane works in (a run started with `isolation: "worktree"`, from the UI, the
 * MCP or the bridge), or `null`. It is looked up by the pane's working directory, so every pane in
 * a worktree is found no matter how it was started. Reloaded whenever the pane's status changes,
 * which is when the diff changes.
 */
export function usePaneWorktree(
  paneId: string,
  status: string,
  given?: Pick<typeof cockpitApi, 'paneWorktree'>,
): WorktreeItem | null {
  const own = useWorktreeApi(paneId);
  const api = given ?? own;
  const [item, setItem] = useState<WorktreeItem | null>(null);

  useEffect(() => {
    setItem(null);
  }, [paneId]);

  useEffect(() => {
    let cancelled = false;
    api
      .paneWorktree(paneId)
      .then((found) => {
        if (!cancelled) setItem(found && found.exists ? found : null);
      })
      .catch(() => {
        // Not in the desktop shell, or the lookup failed: there is nothing to review.
        if (!cancelled) setItem(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api, paneId, status]);

  return item;
}

/** The tab label: `Changes`, or "3 files changed" once there are some. */
export function changesTabLabel(item: WorktreeItem): string {
  const n = item.summary?.files_changed ?? 0;
  return n > 0 ? `${n} ${n === 1 ? 'file' : 'files'} changed` : 'Changes';
}
