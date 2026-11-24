// The dock: the details column to the right of the right panel (the layout of Claude desktop). It is a stack of panes,
// top to bottom: the Background tasks page or one minion's read-only view, one command's output, the agent browser.
// Panes share the height with draggable splitters (sizes remembered in `lib/panel-widths`), a pane folds to its header,
// the whole column folds to a thin strip, and "fill" lies over the chat and the panel (both stay mounted underneath) so
// the column has the whole window beside the sidebar. Its state is `lib/task-view`.
import { createRef, useMemo, type CSSProperties, type ReactNode, type RefObject } from 'react';
import '../../../styles/cockpit-tasks.css';
import { useT } from '../../../i18n';
import { useDockBrowserEnabled } from '../../../lib/dock-browser';
import {
  clearFinishedTasks,
  closeDockPane,
  openBrowserPane,
  openMinionView,
  openTasksPage,
  openTerminalView,
  setDockCollapsed,
  setTaskFull,
  slotOf,
  toggleDockFold,
  useTaskView,
  type DockPane,
  type DockSlot,
} from '../../../lib/task-view';
import {
  DOCK_MAX,
  DOCK_MIN,
  dockShown,
  moveSplit,
  resetDockWidth,
  saveWidths,
  setDockSplit,
  setDockWidth,
  useLayout,
  usePanelWidths,
  useWindowInnerWidth,
} from '../../../lib/panel-widths';
import type { PaneUsage } from '../../../lib/pane-usage';
import type { JobsApi } from '../../../lib/pane-jobs';
import type { CommandOwner } from './helperRows';
import { commandName } from './commandName';
import { AgentLogo } from '../../common/AgentLogo';
import { ResizeHandle } from '../ResizeHandle';
import type { HelperRow } from './BackgroundSection';
import { BackgroundPage } from './BackgroundPage';
import { BrowserPane } from './BrowserPane';
import { DockSplitter } from './DockSplitter';
import { TaskHeader } from './TaskHeader';
import { TaskSideView } from './TaskSideView';
import { TerminalPane } from './TerminalPane';
import { WorkflowLive } from '../../crews/WorkflowLive';
import type { WorkflowModel } from '../../../lib/workflow-model';

export interface TaskColumnProps {
  paneId: string;
  agentName: string;
  agentType: string;
  /** Minions and helpers of this chat, cleared ones left out. */
  rows: readonly HelperRow[];
  /** The agents whose commands the page lists: the chat's own and every agent started under it. */
  owners?: readonly CommandOwner[];
  usage?: PaneUsage | null;
  onOpenPane: (id: string) => void;
  onStopHelper?: (id: string) => Promise<void> | void;
  onStopJob: (owner: string, pid: number, startedAtMs: number, terminalId?: string) => Promise<void>;
  /** Where a terminal's output is read (tests give their own). */
  jobsApi?: JobsApi;
  /** This chat is the front of a workflow (Labs "Workflows"): its live view is the top pane. */
  workflow?: WorkflowModel | null;
  /** A box of the live view was clicked: that agent opens. */
  onOpenWorkflowHelper?: (helperId: string) => void;
  /** "Open the big view" (the crew canvas's Live tab). */
  onOpenWorkflowBig?: () => void;
}

const Glyph = ({ d }: { d: string }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d={d} />
  </svg>
);
const GLYPH: Record<DockSlot, string> = {
  workflow: 'M8 3v5M4 12.5V8h8v4.5',
  view: 'M3 4.5h10M3 8h10M3 11.5h6',
  terminal: 'M3 4.5 7 8l-4 3.5M8.5 12H13',
  browser: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2.5 8h11M8 2.5c1.6 1.6 2.4 3.4 2.4 5.5S9.6 11.9 8 13.5C6.4 11.9 5.6 10.1 5.6 8S6.4 4.1 8 2.5Z',
};

export function TaskColumn({ paneId, agentName, agentType, rows, owners, usage, onOpenPane, onStopHelper, onStopJob, jobsApi, workflow = null, onOpenWorkflowHelper, onOpenWorkflowBig }: TaskColumnProps) {
  const t = useT();
  const state = useTaskView(paneId);
  const { dock: chosenDock, split } = usePanelWidths();
  const layout = useLayout();
  const winW = useWindowInnerWidth();
  const dock = dockShown(chosenDock, winW, layout.sidePx, layout.railPx);
  const browserOn = useDockBrowserEnabled();
  // One ref per slot, so a splitter can measure the two panes beside it.
  const refs = useMemo<Record<DockSlot, RefObject<HTMLDivElement>>>(() => ({ view: createRef<HTMLDivElement>(), workflow: createRef<HTMLDivElement>(), terminal: createRef<HTMLDivElement>(), browser: createRef<HTMLDivElement>() }), []);
  if (!state) return null;
  const { panes, full, collapsed, folded } = state;

  const openOwner = (row: HelperRow) => (row.kind === 'minion' ? openMinionView(paneId, row.id) : onOpenPane(row.id));
  const finished = rows.filter((r) => r.status !== 'running' && r.status !== 'waiting_input');
  const onFull = () => setTaskFull(paneId, !full);
  const slotName = (pane: DockPane): string => {
    if (pane.kind === 'workflow') return workflow?.name ? t('wfdock.title', { name: workflow.name }) : t('wfdock.titleNoName');
    if (pane.kind === 'page') return t('task.pageTitle');
    if (pane.kind === 'terminal') return pane.name;
    if (pane.kind === 'browser') return t('dock.browser');
    return rows.find((r) => r.id === pane.id)?.title ?? t('rail.bg.minion');
  };

  if (collapsed && !full) {
    return (
      <aside className="tk-strip" aria-label={t('dock.strip')} data-testid="dock-strip">
        {panes.map((pane) => (
          <button key={slotOf(pane)} type="button" className="tk-btn tk-icon" data-slot={slotOf(pane)} onClick={() => setDockCollapsed(paneId, false)} aria-label={t('dock.openStrip', { name: slotName(pane) })} title={t('dock.openStrip', { name: slotName(pane) })}>
            <Glyph d={GLYPH[slotOf(pane)]} />
          </button>
        ))}
      </aside>
    );
  }

  const canFold = panes.length > 1;
  const render = (pane: DockPane, index: number): ReactNode => {
    const slot = slotOf(pane);
    const isFolded = folded.includes(slot);
    const common = {
      full,
      onFull,
      onClose: () => closeDockPane(paneId, slot),
      onCollapse: index === 0 ? () => setDockCollapsed(paneId, true) : undefined,
      folded: isFolded,
      onFold: canFold ? () => toggleDockFold(paneId, slot) : undefined,
    };
    let header: ReactNode;
    let body: ReactNode = null;
    if (pane.kind === 'workflow') {
      header = <TaskHeader title={slotName(pane)} logo={<span className="tk-glyph"><Glyph d={GLYPH.workflow} /></span>} {...common} />;
      body = workflow ? <WorkflowLive model={workflow} onOpenHelper={(id) => onOpenWorkflowHelper?.(id)} onOpenBig={onOpenWorkflowBig} /> : <p className="tk-empty">{t('task.gone')}</p>;
    } else if (pane.kind === 'page') {
      header = (
        <TaskHeader
          title={t('task.pageTitle')}
          {...common}
          extra={
            <>
              {browserOn && (
                <button type="button" className="tk-btn tk-icon" data-testid="dock-open-browser" onClick={() => openBrowserPane(paneId)} aria-label={t('dock.openBrowser')} title={t('dock.openBrowser')}>
                  <Glyph d={GLYPH.browser} />
                </button>
              )}
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
                <Glyph d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8" />
              </button>
            </>
          }
        />
      );
      body = (
        <BackgroundPage
          paneId={paneId}
          agentName={agentName}
          agentType={agentType}
          rows={rows}
          owners={owners}
          usage={usage}
          onOpenOwner={openOwner}
          onOpenFinished={openOwner}
          onStopOwner={onStopHelper}
          onStopJob={onStopJob}
          onOpenJob={(owner, job) => openTerminalView(paneId, { owner, pid: job.pid, startedAtMs: job.startedAtMs, name: commandName(job, t), command: job.command, terminalId: job.terminalId })}
          onOpenDone={(owner, done) =>
            openTerminalView(paneId, { owner, pid: 0, startedAtMs: done.startedAtMs, name: commandName(done, t), command: done.command, terminalId: done.terminalId, finished: { state: done.state, endedAtMs: done.endedAtMs } })
          }
        />
      );
    } else if (pane.kind === 'minion') {
      const minion = rows.find((r) => r.id === pane.id);
      const stateWord = minion?.status === 'running' ? t('task.working') : minion?.status === 'waiting_input' ? t('rail.bg.needsYou') : undefined;
      header = (
        <TaskHeader
          title={minion?.title ?? t('rail.bg.minion')}
          logo={minion ? <AgentLogo id={minion.agentType ?? ''} name={minion.agent ?? minion.title} size={16} decorative /> : undefined}
          state={stateWord}
          onBack={() => openTasksPage(paneId)}
          {...common}
        />
      );
      body = minion ? <TaskSideView key={minion.id} row={minion} parentName={agentName} onStop={onStopHelper} /> : <p className="tk-empty">{t('task.gone')}</p>;
    } else if (pane.kind === 'terminal') {
      header = <TaskHeader title={pane.name} logo={<span className="tk-glyph"><Glyph d={GLYPH.terminal} /></span>} onBack={() => closeDockPane(paneId, 'terminal')} {...common} />;
      body = <TerminalPane term={pane} onStop={onStopJob} api={jobsApi} />;
    } else {
      header = <TaskHeader title={t('dock.browser')} logo={<span className="tk-glyph"><Glyph d={GLYPH.browser} /></span>} {...common} />;
      body = <BrowserPane paneId={paneId} />;
    }
    return (
      <>
        {header}
        {!isFolded && body}
      </>
    );
  };

  return (
    <>
      {!full && (
        <ResizeHandle
          className="ck-resize--rail ck-resize--dock"
          grow="left"
          value={dock}
          min={Math.min(DOCK_MIN, dock)}
          max={DOCK_MAX}
          label={t('dock.resize')}
          title={t('dock.resizeTip')}
          onChange={setDockWidth}
          onCommit={saveWidths}
          onReset={resetDockWidth}
        />
      )}
      <section
        className={`tk-col${full ? ' tk-col--full' : ''}`}
        style={full ? undefined : ({ width: dock } as CSSProperties)}
        aria-label={t('task.column')}
        data-testid="task-column"
        data-full={full ? 'true' : undefined}
      >
        {panes.map((pane, i) => {
          const slot = slotOf(pane);
          const prev = i > 0 ? slotOf(panes[i - 1]) : null;
          const isFolded = folded.includes(slot);
          const flex = isFolded ? '0 0 auto' : `${split[slot] ?? 1} 1 0`;
          return (
            <PaneSlot key={slot} slot={slot} prev={prev} folded={isFolded} prevFolded={prev !== null && folded.includes(prev)} flex={flex} refs={refs} onSplit={(topPx, pairPx) => setDockSplit(moveSplit(split, prev as DockSlot, slot, topPx, pairPx))}>
              {render(pane, i)}
            </PaneSlot>
          );
        })}
      </section>
    </>
  );
}

function PaneSlot({
  slot,
  prev,
  folded,
  prevFolded,
  flex,
  refs,
  onSplit,
  children,
}: {
  slot: DockSlot;
  prev: DockSlot | null;
  folded: boolean;
  prevFolded: boolean;
  flex: string;
  refs: Record<DockSlot, RefObject<HTMLDivElement>>;
  onSplit: (topPx: number, pairPx: number) => void;
  children: ReactNode;
}) {
  return (
    <>
      {prev && !folded && !prevFolded && <DockSplitter upper={refs[prev]} lower={refs[slot]} onMove={onSplit} onCommit={saveWidths} />}
      <div ref={refs[slot]} className="tk-pane" data-slot={slot} data-folded={folded ? 'true' : undefined} style={{ flex }}>
        {children}
      </div>
    </>
  );
}
