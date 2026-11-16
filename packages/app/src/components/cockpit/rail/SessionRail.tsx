// The right panel beside a chat: one flat column of plain sections (Environment, Context, Plan, Connectors,
// Outputs, Changes, Background tasks, Files) under a sticky top line (the agent and its state). It reads the same
// session file as the Chat tab (the backend shares one reader between the views; this one holds it under its own id).
import '../../../styles/cockpit-rail.css';
import { RAIL_MAX, RAIL_MIN, RAIL_SNAP, resetRailWidth, saveWidths, setRailWidth, useLayout } from '../../../lib/panel-widths';
import { useT } from '../../../i18n';
import { useToolsDrift } from '../../../hooks/useToolsDrift';
import { ResizeHandle } from '../ResizeHandle';
import { useSessionChat } from '../../../hooks/useSessionChat';
import { usePaneJobs } from '../../../lib/pane-jobs';
import { FilesCard } from '../../files/FilesCard';
import { BackgroundSection, type HelperRow } from './BackgroundSection';
import { TaskColumn } from './TaskColumn';
import { openMinionView, openTasksPage, useClearedTasks } from '../../../lib/task-view';
import type { WorktreeItem } from '../../../lib/cockpit-api';
import { ChangesSection } from './ChangesSection';
import { ConnectorsSection } from './ConnectorsSection';
import { ContextSection } from './ContextSection';
import { EnvironmentSection } from './EnvironmentSection';
import { OutputsSection } from './OutputsSection';
import { PlanSection } from './PlanSection';
import { RailTop, railState } from './RailTop';
import { previewJobPort, stopJob } from './jobActions';
import { tauriJobsApi, type JobsApi } from '../../../lib/pane-jobs';
import { usePaneConnectors } from './usePaneConnectors';
import { usePaneUsage } from './usePaneUsage';
import { usePaneBranch } from './usePaneBranch';

export type { HelperRow };

export interface SessionRailProps {
  paneId: string;
  status: string;
  cwd: string;
  /** The agent's id (its logo). */
  agentType: string;
  agentName: string;
  accountLabel?: string | null;
  /** The device name when the chat runs on another computer; null: this computer. */
  runsOn?: string | null;
  /** Read the agent's session file (false for a plain shell: it has none). */
  readsChat: boolean;
  /** "Helper of X" and the pane it opens, when this pane was started by another. */
  helperOf: { parentId: string; text: string } | null;
  helpers: readonly HelperRow[];
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
  /** "Save this team" (in the Background tasks section's right-click menu). */
  onSaveTeam?: () => void;
  /** Dragging the left edge under the snap width hides the panel. */
  onClose?: () => void;
  onNotify?: (text: string) => void;
  jobsApi?: JobsApi;
}

export function SessionRail({
  paneId,
  status,
  cwd,
  agentType,
  agentName,
  accountLabel,
  runsOn = null,
  readsChat,
  helperOf,
  helpers,
  copy = null,
  canCreatePr = false,
  ask = null,
  onAnswer,
  onOpenChanges,
  worktree = null,
  onOpenCopy,
  onOpenPane,
  onStopHelper,
  onSaveTeam,
  onClose,
  onNotify,
  jobsApi = tauriJobsApi,
}: SessionRailProps) {
  const t = useT();
  const { railPx } = useLayout();
  const chat = useSessionChat(paneId, readsChat);
  const branch = usePaneBranch(paneId, status, true);
  const jobs = usePaneJobs()[paneId] ?? [];
  const connectors = usePaneConnectors(chat.turns);
  const drift = useToolsDrift();
  const cleared = useClearedTasks(paneId);
  const rows = helpers.filter((h) => !cleared.has(h.id));
  const stale = drift.rows.some((r) => r.paneId === paneId);
  const canReconnect = drift.rows.some((r) => r.paneId === paneId && r.canReconnect);
  // Re-read the helpers' usage whenever a status changes: a turn ending is a status change.
  const usage = usePaneUsage(paneId, rows.length > 0, [status, ...rows.map((h) => `${h.id}:${h.status}`)].join('|'));
  const stopOwnJob = (owner: string, pid: number, startedAtMs: number) => stopJob(jobsApi, owner, pid, startedAtMs);
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
          tip={tip}
          state={railState(status, fresh && status !== 'running')}
          helperOf={helperOf}
          onOpenParent={onOpenPane}
          ask={ask}
          onAnswer={onAnswer ?? (() => undefined)}
        />
        <EnvironmentSection paneId={paneId} cwd={cwd} runsOn={runsOn} branch={branch} copy={copy} onOpenCopy={onOpenCopy} />
        <ContextSection usage={chat.usage} fresh={fresh} />
        <PlanSection plan={chat.plan} />
        <ConnectorsSection
          connectors={connectors}
          outOfDate={stale}
          reconnecting={drift.busy === paneId}
          onReconnect={() => (canReconnect ? void drift.reconnect(paneId, t('rail.con.reconnect')) : undefined)}
        />
        <OutputsSection paneId={paneId} cwd={cwd} outputs={chat.outputs} />
        <ChangesSection paneId={paneId} status={status} cwd={cwd} outputs={chat.outputs} canCreatePr={canCreatePr} showDone={readsChat} onOpenChanges={onOpenChanges} onNotify={onNotify} worktree={worktree} />
        <BackgroundSection
          helpers={rows}
          usage={usage}
          jobs={jobs}
          onOpenPane={onOpenPane}
          onOpenTask={(id) => openMinionView(paneId, id)}
          onOpenPage={() => openTasksPage(paneId)}
          onStopHelper={onStopHelper}
          onStopJob={(pid, startedAtMs) => stopJob(jobsApi, paneId, pid, startedAtMs)}
          onPreview={(port, external) => previewJobPort(paneId, port, external)}
          onPointFix={(port) => previewJobPort(paneId, port, false, true)}
          onSaveTeam={onSaveTeam}
        />
        <FilesCard paneId={paneId} cwd={cwd} canMention={readsChat} refreshKey={status} />
      </aside>
      <TaskColumn paneId={paneId} agentName={agentName} agentType={agentType} rows={rows} usage={usage} onOpenPane={onOpenPane} onStopHelper={onStopHelper} onStopJob={stopOwnJob} />
    </>
  );
}
