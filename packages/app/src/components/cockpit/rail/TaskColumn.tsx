// The details column to the right of the right panel (the layout of Claude desktop): the full Background tasks page, or
// one minion's read-only view. The chat gets narrower and the panel stays. "Fill" lies over the chat and the panel
// (both stay mounted underneath) so the view has the whole window beside the sidebar. Its state is `lib/task-view`.
import '../../../styles/cockpit-tasks.css';
import { useT } from '../../../i18n';
import { clearFinishedTasks, closeTaskView, openMinionView, openTasksPage, setTaskFull, useTaskView } from '../../../lib/task-view';
import type { PaneUsage } from '../../../lib/pane-usage';
import { AgentLogo } from '../../common/AgentLogo';
import type { HelperRow } from './BackgroundSection';
import { BackgroundPage } from './BackgroundPage';
import { TaskHeader } from './TaskHeader';
import { TaskSideView } from './TaskSideView';

export interface TaskColumnProps {
  paneId: string;
  agentName: string;
  agentType: string;
  /** Minions and helpers of this chat, cleared ones left out. */
  rows: readonly HelperRow[];
  usage?: PaneUsage | null;
  onOpenPane: (id: string) => void;
  onStopHelper?: (id: string) => Promise<void> | void;
  onStopJob: (owner: string, pid: number, startedAtMs: number) => Promise<void>;
}

export function TaskColumn({ paneId, agentName, agentType, rows, usage, onOpenPane, onStopHelper, onStopJob }: TaskColumnProps) {
  const t = useT();
  const state = useTaskView(paneId);
  if (!state) return null;
  const { view, full } = state;
  const minion = view.kind === 'minion' ? rows.find((r) => r.id === view.id) : undefined;
  const common = { full, onFull: () => setTaskFull(paneId, !full), onClose: () => closeTaskView(paneId) };
  const openOwner = (row: HelperRow) => (row.kind === 'minion' ? openMinionView(paneId, row.id) : onOpenPane(row.id));
  const finished = rows.filter((r) => r.status !== 'running' && r.status !== 'waiting_input');
  return (
    <section className={`tk-col${full ? ' tk-col--full' : ''}`} aria-label={t('task.column')} data-testid="task-column" data-full={full ? 'true' : undefined}>
      {view.kind === 'page' ? (
        <>
          <TaskHeader
            title={t('task.pageTitle')}
            {...common}
            extra={
              <button
                type="button"
                className="tk-btn tk-icon"
                disabled={finished.length === 0}
                onClick={() =>
                  clearFinishedTasks(
                    paneId,
                    finished.map((r) => r.id),
                  )
                }
                aria-label={t('task.clear')}
                title={t('task.clear')}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8" />
                </svg>
              </button>
            }
          />
          <BackgroundPage
            paneId={paneId}
            agentName={agentName}
            agentType={agentType}
            rows={rows}
            usage={usage}
            onOpenOwner={openOwner}
            onOpenFinished={openOwner}
            onStopOwner={onStopHelper}
            onStopJob={onStopJob}
          />
        </>
      ) : (
        <>
          <TaskHeader
            title={minion?.title ?? t('rail.bg.minion')}
            logo={minion ? <AgentLogo id={minion.agentType ?? ''} name={minion.agent ?? minion.title} size={16} decorative /> : undefined}
            onBack={() => openTasksPage(paneId)}
            {...common}
          />
          {minion ? <TaskSideView key={minion.id} row={minion} parentName={agentName} onStop={onStopHelper} /> : <p className="tk-empty">{t('task.gone')}</p>}
        </>
      )}
    </section>
  );
}
