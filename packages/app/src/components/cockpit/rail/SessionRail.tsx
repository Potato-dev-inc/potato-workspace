// The "Session" rail beside a pane's main area: small cards that say where the pane runs, how full its context
// is, what the agent plans, what it changed and which helpers it started and what it left running in the background. It reads the same session file as the
// Chat tab (the backend shares one reader between the views; this one holds it under its own id).
import '../../../styles/cockpit-rail.css';
import { RAIL_MAX, RAIL_MIN, resetRailWidth, saveWidths, setRailWidth, useLayout } from '../../../lib/panel-widths';
import { useT } from '../../../i18n';
import { ResizeHandle } from '../ResizeHandle';
import { useSessionChat } from '../../../hooks/useSessionChat';
import { usePaneJobs } from '../../../lib/pane-jobs';
import { BackgroundCard } from './BackgroundCard';
import { ChangesCard } from './ChangesCard';
import { ContextCard } from './ContextCard';
import { FilesCard } from '../../files/FilesCard';
import { HelpersCard, type HelperRow } from './HelpersCard';
import { RemoteCard } from './RemoteCard';
import { TasksCard } from './TasksCard';
import { usePaneUsage } from './usePaneUsage';
import { WhereCard } from './WhereCard';
import { usePaneBranch } from './usePaneBranch';

export interface SessionRailProps {
  paneId: string;
  status: string;
  cwd: string;
  agentName: string;
  accountLabel?: string | null;
  /** Read the agent's session file (false for a plain shell: it has none). */
  readsChat: boolean;
  /** "Helper of X" and the pane it opens, when this pane was started by another. */
  helperOf: { parentId: string; text: string } | null;
  helpers: readonly HelperRow[];
  /** Set when the pane has a Changes tab; a file in the Changes card opens it. */
  onOpenChanges?: () => void;
  onOpenPane: (id: string) => void;
  /** "Save this team" in the Helpers card (the card only exists when the pane has helpers). */
  onSaveTeam?: () => void;
}

export function SessionRail({ paneId, status, cwd, agentName, accountLabel, readsChat, helperOf, helpers, onOpenChanges, onOpenPane, onSaveTeam }: SessionRailProps) {
  const t = useT();
  const { railPx } = useLayout();
  const chat = useSessionChat(paneId, readsChat);
  const branch = usePaneBranch(paneId, status, true);
  const jobs = usePaneJobs()[paneId] ?? [];
  // Re-read the helpers' usage whenever a status changes: a turn ending is a status change.
  const usage = usePaneUsage(paneId, helpers.length > 0, [status, ...helpers.map((h) => `${h.id}:${h.status}`)].join('|'));
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
      onChange={setRailWidth}
      onCommit={saveWidths}
      onReset={resetRailWidth}
    />
    <aside className="ck-rail" aria-label="Session details" data-testid="session-rail" style={{ width: railPx }}>
      {helperOf && (
        <button type="button" className="ck-rail-parent" onClick={() => onOpenPane(helperOf.parentId)} title="Open the pane that started this one">
          {helperOf.text}
        </button>
      )}
      <WhereCard agentName={agentName} model={chat.model} cliVersion={chat.cliVersion} folder={cwd} branch={branch} accountLabel={accountLabel} />
      <ContextCard usage={chat.usage} />
      <TasksCard plan={chat.plan} />
      <ChangesCard outputs={chat.outputs} cwd={cwd} onOpenChanges={onOpenChanges} />
      <FilesCard paneId={paneId} cwd={cwd} canMention={readsChat} refreshKey={status} />
      <BackgroundCard paneId={paneId} jobs={jobs} />
      <HelpersCard helpers={helpers} usage={usage} onOpen={onOpenPane} onSaveTeam={onSaveTeam} />
      <RemoteCard paneId={paneId} />
    </aside>
    </>
  );
}
