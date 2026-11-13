// Connects the New agent page to the cockpit: the agent list, the panes, what needs the person, and the start path.
import { useMemo } from 'react';
import type { CockpitApi } from '../../../hooks/useCockpit';
import { useNeedsYou } from '../../../hooks/useNeedsYou';
import { agentLabel, useAgentRegistry } from '../../../lib/agentRegistry';
import { blockingItems, needsYouPaneIds } from '../../../lib/attention';
import { tauriClosedChatsApi } from '../../../lib/closedChats';
import { isCompanionPaneId } from '../companion/model';
import type { SplitMemory } from '../split-memory';
import { previousRun } from '../yesterday-memory';
import { NewAgentPage, type PaneBrief } from './NewAgentPage';
import { realStartDeps, runStart } from './start';

export function NewAgentHost({
  c,
  project = null,
  onSetUp,
  onReopenedRun,
}: {
  c: CockpitApi;
  project?: { path: string; name: string } | null;
  onSetUp?: () => void;
  /** Chats from the last run came back: their pane ids, and the split they had (or null). */
  onReopenedRun?: (paneIds: string[], split: SplitMemory | null) => void;
}) {
  const listing = useAgentRegistry();
  const needsItems = useNeedsYou(c);
  const waiting = useMemo(() => needsYouPaneIds(blockingItems(needsItems)), [needsItems]);

  const briefs = useMemo<PaneBrief[]>(
    () =>
      c.registry.paneList
        .filter((p) => !isCompanionPaneId(p.info.id))
        .map((p) => ({ id: p.info.id, title: c.names.get(p.info.id) ?? agentLabel(listing, p.info.agent_type), status: p.status })),
    [c.registry.paneList, c.names, listing],
  );
  const selectedCwd = c.selectedId ? c.registry.panes.get(c.selectedId)?.info.cwd : null;

  const runningFolders = useMemo(
    () => c.registry.paneList.filter((p) => !isCompanionPaneId(p.info.id) && p.info.cwd).map((p) => p.info.cwd as string),
    [c.registry.paneList],
  );
  const openIds = useMemo(() => c.registry.paneList.map((p) => p.info.id), [c.registry.paneList]);

  return (
    <NewAgentPage
      agents={listing.agents}
      panes={briefs}
      needs={briefs.filter((p) => waiting.has(p.id))}
      selectedCwd={selectedCwd}
      project={project}
      runningFolders={runningFolders}
      onOpenPane={(id) => c.select(id)}
      onSetUp={onSetUp}
      continueYesterday={{
        previous: previousRun(),
        api: tauriClosedChatsApi,
        openIds,
        onReopened: (paneIds, split) => (onReopenedRun ? onReopenedRun(paneIds, split) : paneIds[0] && c.select(paneIds[0])),
      }}
      // The agent's own terminal pane, in the folder: the person signs in there (the same login Chat uses).
      onSignIn={(agentId, folder) => c.newAgent(agentId, undefined, false, folder, undefined, 'terminal')}
      onStart={(request) => runStart(request, realStartDeps({ newAgent: c.newAgent, select: c.select, notify: c.notify }))}
    />
  );
}
