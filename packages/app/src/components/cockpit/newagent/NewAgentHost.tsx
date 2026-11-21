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
import { NewAgentWhere, type WhereProps } from '../../devices/NewAgentWhere';
import { NewAgentPage, type PaneBrief } from './NewAgentPage';
import { t } from '../../../i18n';
import { sendPaneMessage } from '../../../lib/paneOutbox';
import { realStartDeps, runStart } from './start';
import type { LinuxPlace } from '../../devices/NewAgentWhere';
import type { StartRequest } from './model';

/** The usual composer, started inside a Linux distro: a terminal pane there in the chosen folder, then the first message. */
async function startInLinux(place: LinuxPlace, request: StartRequest, notify: (text: string) => void): Promise<string | null> {
  let paneId: string;
  try {
    paneId = await place.start(request.agentId, request.folder);
  } catch (e) {
    notify(e instanceof Error ? e.message : typeof e === 'string' ? e : t('devices.wsl.errStart'));
    return null;
  }
  try {
    await sendPaneMessage(paneId, request.prompt);
  } catch {
    notify(t('devices.wsl.errSend'));
  }
  return paneId;
}

export function NewAgentHost({
  c,
  project = null,
  onSetUp,
  onReopenedRun,
  where,
}: {
  c: CockpitApi;
  project?: { path: string; name: string; node?: string } | null;
  onSetUp?: () => void;
  /** Chats from the last run came back: their pane ids, and the split they had (or null). */
  onReopenedRun?: (paneIds: string[], split: SplitMemory | null) => void;
  /** Devices (Labs): the Where pill. Absent: the page is as it was. */
  where?: WhereProps;
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
    <NewAgentWhere where={where ? { ...where, notify: where.notify ?? c.notify } : where} remember={project?.path ?? ''} preselect={project?.node ? { node: project.node, folder: { path: project.path, name: project.name } } : undefined}>
      {(pill, slot, extras) => {
        // Another PC picked: the same page, inside that PC's host (its agents, folders, models and pins come through it). Nothing of this PC is passed down.
        const far = slot?.remote ?? null;
        return (
    <NewAgentPage
      key={far?.node ?? 'this-pc'}
      leading={pill}
      devices={extras.picker}
      startFolder={extras.startFolder}
      place={extras.place ? { name: extras.place.distro, whyNot: extras.place.whyNot } : null}
      remote={far ? { deviceName: far.deviceName, terminals: far.terminals, blocked: slot?.blocked ?? null, onWarm: far.warm, agentsOff: slot?.agentsOff } : null}
      agents={far ? undefined : listing.agents}
      panes={far ? [] : briefs}
      needs={far ? [] : briefs.filter((p) => waiting.has(p.id))}
      selectedCwd={far ? null : selectedCwd}
      project={far || project?.node ? null : project}
      runningFolders={far ? [] : runningFolders}
      onOpenPane={(id) => c.select(id)}
      onSetUp={far ? undefined : onSetUp}
      continueYesterday={
        far
          ? undefined
          : {
              previous: previousRun(),
              api: tauriClosedChatsApi,
              openIds,
              onReopened: (paneIds, split) => (onReopenedRun ? onReopenedRun(paneIds, split) : paneIds[0] && c.select(paneIds[0])),
            }
      }
      // The agent's own terminal pane, in the folder: the person signs in there (the same login Chat uses).
      onSignIn={far ? undefined : (agentId, folder) => c.newAgent(agentId, undefined, false, folder, undefined, 'terminal')}
      onStart={far ? far.onStart : extras.place ? (request) => startInLinux(extras.place!, request, c.notify) : (request) => runStart(request, realStartDeps({ newAgent: c.newAgent, select: c.select, notify: c.notify }))}
    />
        );
      }}
    </NewAgentWhere>
  );
}
