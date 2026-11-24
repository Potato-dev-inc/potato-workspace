// The git branch of the folder a pane works in (null when it is not a git folder). Looked up again whenever the
// pane's status changes, which is when the agent may have switched branch.
import { useEffect, useMemo, useState } from 'react';
import { cockpitApi } from '../../../lib/cockpit-api';
import { useHost } from '../../../lib/host/context';
import { useHostApi } from '../../../lib/host/hostApi';
import type { Host } from '../../../lib/host/host';

type BranchApi = Pick<typeof cockpitApi, 'paneGitBranch'>;
const local: BranchApi = cockpitApi;
const farBranch = (host: Host): BranchApi => ({ paneGitBranch: (paneId) => host.invoke<string | null>('pane_git_branch', { paneId }) });

/** A far PC answers a folder with no branch as an empty object (its null comes back as {}): only a non-empty string is a branch. */
export const branchName = (found: unknown): string | null => (typeof found === 'string' && found.trim() ? found : null);

export function usePaneBranch(
  paneId: string,
  status: string,
  enabled: boolean,
  given?: BranchApi,
): string | null {
  const own = useHostApi(local, farBranch);
  const api = given ?? own;
  const [branch, setBranch] = useState<string | null>(null);

  useEffect(() => {
    setBranch(null);
  }, [paneId]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api
      .paneGitBranch(paneId)
      .then((found) => {
        if (!cancelled) setBranch(branchName(found));
      })
      .catch(() => {
        // Not in the desktop shell, or the lookup failed: no branch line.
        if (!cancelled) setBranch(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api, paneId, status, enabled]);

  return branch;
}
