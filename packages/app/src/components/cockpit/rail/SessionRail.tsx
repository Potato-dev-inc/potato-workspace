// The right panel beside a chat: one flat column of plain sections (Environment, Context, Plan, Connectors,
// Outputs, Changes, Background tasks, Files) under a sticky top line (the agent and its state). It reads the same
// session file as the Chat tab (the backend shares one reader between the views; this one holds it under its own id).
import { WhenSeen } from './WhenSeen';
import { useMemo } from 'react';
import '../../../styles/cockpit-rail.css';
import { RAIL_MAX, RAIL_MIN, RAIL_SNAP, resetRailWidth, saveWidths, setRailWidth, useLayout } from '../../../lib/panel-widths';
import { useT } from '../../../i18n';
import { useToolsDrift } from '../../../hooks/useToolsDrift';
import { ResizeHandle } from '../ResizeHandle';
import { useSessionChat } from '../../../hooks/useSessionChat';
import { useFinishedCommands, usePaneJobs } from '../../../lib/pane-jobs';
import { FilesCard } from '../../files/FilesCard';
import { useRemotePane } from '../../../lib/remotePanes';
import { remoteFsApi, useTurnEnds, type RemoteFsApi } from '../../../lib/remoteFs';
import { useHost } from '../../../lib/host/context';
import { RailSection } from './RailSection';
import { usePaneFilesVersion } from '../../../lib/turn-review';
import { RemoteChangesSection, RemoteEnvSection, RemoteFilesSection, useRemoteStatus } from './RemoteSections';
import { BackgroundSection, type HelperRow } from './BackgroundSection';
import { TaskColumn } from './TaskColumn';
import { openMinionView, openTasksPage, openTerminalView, useClearedTasks } from '../../../lib/task-view';
import { commandRows, finishedRows, type CommandRow, type FinishedRow } from './commandRows';
import { commandName } from './commandName';
import type { CommandOwner } from './helperRows';
import type { WorktreeItem } from '../../../lib/cockpit-api';
import { ChangesSection } from './ChangesSection';
import { ConnectorsSection } from './ConnectorsSection';
import { ContextSection } from './ContextSection';
import { steadyUsage } from '../../../lib/contextWindow';
import { EnvironmentSection } from './EnvironmentSection';
import { OutputsSection } from './OutputsSection';
import { PlanSection } from './PlanSection';
import { RailTop, railState } from './RailTop';
import { previewJobPort, stopCommand, stopJob } from './jobActions';
import { tauriJobsApi, type JobsApi } from '../../../lib/pane-jobs';
import { usePaneConnectors } from './usePaneConnectors';
import { usePaneUsage } from './usePaneUsage';
import { usePaneBranch } from './usePaneBranch';
import type { WorkflowModel } from '../../../lib/workflow-model';

export type { HelperRow };

export interface SessionRailProps {
  paneId: string;
  status: string;
  cwd: string;
  /** The agent's id (its logo). */
  agentType: string;
  agentName: string;
  /** The chat's own name (after a rename); the panel top shows it. */
  title?: string;
  accountLabel?: string | null;
  /** The device name when the chat runs on another computer; null: this computer. */
  runsOn?: string | null;
  /** Read the agent's session file (false for a plain shell: it has none). */
  readsChat: boolean;
  /** "Helper of X" and the pane it opens, when this pane was started by another. */
  helperOf: { parentId: string; text: string } | null;
  helpers: readonly HelperRow[];
  /** Standbys of this agent that are set to "minion" and ready: "N ready" in Background tasks (they have no sidebar row). */
  readyMinions?: number;
  /** The agents whose commands this chat lists: its own agent first, then every agent started under it (minions, spin-offs). */
  owners?: readonly CommandOwner[];
  /** The chat works on a copy of its project ("Work on a copy"). */
  copy?: { kind: 'git' | 'plain' } | null;
  /** The chat works on a copy of a git project: a pull request can be made. */
  canCreatePr?: boolean;
  /** What the agent asks, in one line, while it waits on the person. */
  ask?: string | null;
  /** The orange row was clicked: scroll the chat to the question. */
  onAnswer?: () => void;
  /** Set when the pane has a Changes tab; a file in the Changes section opens it. */
  onOpenChanges?: () => void;
  /** The chat's copy (separate folder), when it works on one: Keep all in Changes merges it. */
  worktree?: WorktreeItem | null;
  onOpenCopy?: () => void;
  onOpenPane: (id: string) => void;
  onStopHelper?: (id: string) => Promise<void> | void;
  /** The other agents a minion can be handed to ("Hand to ..." in a Background tasks row's menu), and the choice. */
  handTargets?: readonly { id: string; name: string }[];
  onHandMinion?: (minion: HelperRow, toId: string) => void;
  /** "Save this team" (in the Background tasks section's right-click menu). */
  onSaveTeam?: () => void;
  /** Dragging the left edge under the snap width hides the panel. */
  onClose?: () => void;
  onNotify?: (text: string) => void;
  jobsApi?: JobsApi;
  /** This chat is the front of a workflow (Labs "Workflows"): the details column can show its live view. */
  workflow?: WorkflowModel | null;
  onOpenWorkflowHelper?: (helperId: string) => void;
  onOpenWorkflowBig?: () => void;
  /** Reads of a project on another computer (tests give their own). */
  remoteFs?: RemoteFsApi;
}

/** A section of the panel whose data this place cannot give yet: the same header, one plain line. */
function NotHere({ id, title, reason }: { id: 'out' | 'chg' | 'files'; title: string; reason: string }) {
  return (
    <RailSection id={id} title={title} testId={`rail-not-here-${id}`}>
      <div className="rp-row is-empty">
        <span className="rp-name">{reason}</span>
      </div>
    </RailSection>
  );
}

/** Changes whenever a turn starts, ends or writes a file, whatever the sampled status did. */
const turnKeyOf = (chat: { turns: readonly { id: string; outcome: unknown; end: unknown }[]; outputs: readonly unknown[] }) => {
  const last = chat.turns[chat.turns.length - 1];
  return `${chat.turns.length}:${last?.id ?? ''}:${last?.outcome ? 1 : 0}${last?.end ? 1 : 0}:${chat.outputs.length}`;
};

export function SessionRail({
  paneId,
  status,
  cwd,
  agentType,
  agentName,
  title,
  accountLabel,
  runsOn = null,
  readsChat,
  helperOf,
  helpers,
  readyMinions = 0,
  owners,
  copy = null,
  canCreatePr = false,
  ask = null,
  onAnswer,
  onOpenChanges,
  worktree = null,
  onOpenCopy,
  onOpenPane,
  onStopHelper,
  handTargets,
  onHandMinion,
  onSaveTeam,
  onClose,
  onNotify,
  jobsApi = tauriJobsApi,
  workflow = null,
  onOpenWorkflowHelper,
  onOpenWorkflowBig,
  remoteFs = remoteFsApi,
}: SessionRailProps) {
  const t = useT();
  // The sections that read this PC's disk and git for the pane (outputs, changes, files, Remote control) are answered by the place the screen
  // shows; where a place cannot yet, the same sections are drawn with its one reason.
  const host = useHost();
  // Not yet: the place has no such call (an older PC). Not allowed: it has it, and this person's level there does not reach a folder (Full).
  const noFiles = host.can?.('files_list') === false ? (host.notYet ?? '') : (host.denied?.('files_write') ?? null);
  const here = noFiles === null;
  const notYet = noFiles ?? '';
  const { railPx } = useLayout();
  const chat = useSessionChat(paneId, readsChat);
  // A chat on another computer over SSH: this PC's disk and git say nothing about its folder, so none of it is read.
  const remote = useRemotePane(paneId);
  const branch = usePaneBranch(paneId, status, !remote);
  // The branch and the changes of a project on another computer: read over ssh when the panel opens and when a turn ends, never polled.
  // A Put back or its Undo changed the files without a turn: Changes, Files and the far panels read again.
  const touched = usePaneFilesVersion(paneId);
  const turnEnds = `${useTurnEnds(status)}|${touched}`;
  const remoteStatus = useRemoteStatus(paneId, turnEnds, remoteFs, !!remote);
  const allJobs = usePaneJobs();
  const allFinished = useFinishedCommands();
  const commandOwners = useMemo<readonly CommandOwner[]>(() => owners ?? [{ id: paneId, name: '', agentType: null, status, self: true }], [owners, paneId, status]);
  const commands = useMemo(() => commandRows(allJobs, commandOwners), [allJobs, commandOwners]);
  const finishedCommands = useMemo(() => finishedRows(allFinished, commandOwners), [allFinished, commandOwners]);
  const connectors = usePaneConnectors(chat.turns);
  const drift = useToolsDrift();
  const cleared = useClearedTasks(paneId);
  const rows = helpers.filter((h) => !cleared.has(h.id));
  const stale = drift.rows.some((r) => r.paneId === paneId);
  const canReconnect = drift.rows.some((r) => r.paneId === paneId && r.canReconnect);
  // Re-read the helpers' usage whenever a status changes: a turn ending is a status change.
  const usage = usePaneUsage(paneId, rows.length > 0, [status, ...rows.map((h) => `${h.id}:${h.status}`)].join('|'));
  const stopOwnJob = (owner: string, pid: number, startedAtMs: number, terminalId?: string) => stopCommand(jobsApi, owner, { pid, startedAtMs, terminalId });
  const openCommand = (row: CommandRow) =>
    openTerminalView(paneId, { owner: row.owner.id, pid: row.job.pid, startedAtMs: row.job.startedAtMs, name: commandName(row.job, t), command: row.job.command, terminalId: row.job.terminalId });
  const openFinished = (row: FinishedRow) =>
    openTerminalView(paneId, {
      owner: row.owner.id,
      pid: 0,
      startedAtMs: row.done.startedAtMs,
      name: commandName(row.done, t),
      command: row.done.command,
      terminalId: row.done.terminalId,
      finished: { state: row.done.state, endedAtMs: row.done.endedAtMs },
    });
  const fresh = chat.turns.length === 0;
  const tip = [agentName, chat.model, chat.cliVersion, accountLabel].filter(Boolean).join(' · ');
  return (
    <>
      <ResizeHandle
        className="ck-resize--rail"
        grow="left"
        value={railPx}
        min={RAIL_MIN}
        max={RAIL_MAX}
        label={t('pane.resizePanel')}
        title={t('pane.resizePanelTip')}
        onChange={(px) => (px < RAIL_SNAP && onClose ? onClose() : setRailWidth(px))}
        onCommit={saveWidths}
        onReset={resetRailWidth}
      />
      <aside className="ck-rail" aria-label={t('rail.label')} data-testid="session-rail" style={{ width: railPx }}>
        <RailTop
          agentType={agentType}
          agentName={agentName}
          title={title}
          tip={tip}
          state={railState(status, fresh && status !== 'running', host.ended === true)}
          helperOf={helperOf}
          onOpenParent={onOpenPane}
          ask={ask}
          onAnswer={onAnswer ?? (() => undefined)}
        />
        {remote ? (
          <>
            <RemoteEnvSection name={remote.name} cwd={cwd} far={remoteStatus} />
            <section className="rp-sec" aria-label={t('devices.ssh.modeChat')} data-testid="rail-remote-note">
              <p className="ck-sub">{t('devices.ssh.remoteNoPanel', { name: remote.name })}</p>
            </section>
          </>
        ) : (
          <EnvironmentSection paneId={paneId} cwd={cwd} runsOn={runsOn} branch={branch} copy={copy} onOpenCopy={onOpenCopy} blocked={here ? null : notYet} far={host.notYet !== undefined} />
        )}
        <ContextSection usage={steadyUsage(paneId, chat.model, chat.usage)} fresh={fresh} />
        <PlanSection plan={chat.plan} />
        <ConnectorsSection
          connectors={connectors}
          outOfDate={stale}
          reconnecting={drift.busy === paneId}
          onReconnect={() => (canReconnect ? void drift.reconnect(paneId, t('rail.con.reconnect')) : undefined)}
        />
        {!remote && here && <OutputsSection paneId={paneId} cwd={cwd} outputs={chat.outputs} />}
        {!remote && !here && <NotHere id="out" title={t('rail.out.title')} reason={notYet} />}
        {remote && <RemoteChangesSection name={remote.name} far={remoteStatus} />}
        {!remote && !here && <NotHere id="chg" title={t('rail.chg.title')} reason={notYet} />}
        {!remote && here && <WhenSeen><ChangesSection paneId={paneId} status={status} turnKey={`${turnKeyOf(chat)}|${touched}`} cwd={cwd} outputs={chat.outputs} canCreatePr={canCreatePr} showDone={readsChat} onOpenChanges={onOpenChanges} onNotify={onNotify} worktree={worktree} /></WhenSeen>}
        <BackgroundSection
          helpers={rows}
          readyCount={readyMinions}
          usage={usage}
          commands={commands}
          finishedCommands={finishedCommands}
          onOpenCommand={openCommand}
          onOpenFinishedCommand={openFinished}
          onOpenPane={onOpenPane}
          onOpenTask={(id) => openMinionView(paneId, id)}
          onOpenPage={() => openTasksPage(paneId)}
          onStopHelper={onStopHelper}
          onStopJob={(pid, startedAtMs, row) => stopCommand(jobsApi, row?.owner.id ?? paneId, { pid, startedAtMs, terminalId: row?.job.terminalId })}
          onPreview={(port, external) => previewJobPort(paneId, port, external)}
          onPointFix={(port) => previewJobPort(paneId, port, false, true)}
          onSaveTeam={onSaveTeam}
          ownerId={paneId}
          ownerName={agentName}
          handTargets={handTargets}
          onHand={onHandMinion}
        />
        {!remote && !here && <NotHere id="files" title={t('files.title')} reason={notYet} />}
        {remote ? <RemoteFilesSection paneId={paneId} name={remote.name} refreshKey={turnEnds} api={remoteFs} /> : here && <WhenSeen><FilesCard paneId={paneId} cwd={cwd} canMention={readsChat} refreshKey={`${status}|${touched}`} /></WhenSeen>}
      </aside>
      <TaskColumn paneId={paneId} agentName={agentName} agentType={agentType} rows={rows} owners={commandOwners} usage={usage} onOpenPane={onOpenPane} onStopHelper={onStopHelper} onStopJob={stopOwnJob} jobsApi={jobsApi} workflow={workflow} onOpenWorkflowHelper={onOpenWorkflowHelper} onOpenWorkflowBig={onOpenWorkflowBig} />
    </>
  );
}
