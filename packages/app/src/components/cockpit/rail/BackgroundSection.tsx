// Background tasks: everything running for this chat, one row each. Helpers (logo, name), commands (pulsing dot, the
// command in mono), with the time it ran and a small stop square that asks once. A helper waiting on the person says
// "Needs you". The last row, "N finished", opens the list of the ones that are done. "Save this team" is in the
// section's right-click menu.
//
// A row can also be put in the sidebar: drag it there, or use its right-click menu (the Menu key and Shift+F10 on the focused
// row): Show in sidebar, Hand to another agent, Stop. A row that is in the sidebar says so, and a row dragged back onto this
// section goes back (its sidebar row goes; the task keeps running).
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useT } from '../../../i18n';
import { canStop, runTime, type PaneJob } from '../../../lib/pane-jobs';
import { errorSentence } from '../../../lib/sayError';
import type { PaneUsage } from '../../../lib/pane-usage';
import { jobTaskId, minionTaskId, removeTaskFromSidebar, showTaskInSidebar, useTaskSidebar, type TaskPlacement } from '../../../lib/task-sidebar';
import { AgentLogo } from '../../common/AgentLogo';
import { announce } from '../../dnd/announce';
import { dragSourceProps } from '../../dnd/dragSourceProps';
import { registerDropZone, useDragOver } from '../../dnd/dragStore';
import { FloatingMenu } from '../FloatingMenu';
import { RailSection } from './RailSection';
import { StallNotice } from '../StallNotice';
import { clockText } from './railFormat';
import '../../../styles/cockpit-taskdrag.css';
import { commandName } from './commandName';
import { showsBy, type CommandRow, type FinishedRow } from './commandRows';

export interface HelperRow {
  id: string;
  title: string;
  agent: string | null;
  /** The agent's id, for its logo. */
  agentType?: string | null;
  status: string;
  /** `minion`: a small worker of this chat; it opens in the details column. Else a helper: it opens its own pane. */
  kind?: 'minion' | 'helper';
  /** A minion's start (ms since the epoch): its row counts the time live. */
  startedAtMs?: number;
}

/** How long a row has run: a working minion counts live from its start; any other row reads the usage figure. */
export function rowElapsedMs(row: HelperRow, now: number, usageMs: number): number {
  return row.kind === 'minion' && row.startedAtMs && (row.status === 'running' || row.status === 'waiting_input') ? Math.max(0, now - row.startedAtMs) : usageMs;
}

const isRunning = (s: string) => s === 'running';
const isWaiting = (s: string) => s === 'waiting_input';

function useClock(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** The small stop square. A first click asks "Stop this one?" with Yes and No; Yes does it. */
export function StopSquare({ name, onStop, ask }: { name: string; onStop: () => Promise<void> | void; /** The question, when it is not the plain "Stop this one?" (a command an agent is waiting on). */ ask?: string }) {
  const t = useT();
  const [phase, setPhase] = useState<'idle' | 'asking' | 'stopping'>('idle');
  const [error, setError] = useState<string | null>(null);
  if (phase === 'asking') {
    return (
      <span className="rp-ask" role="group" aria-label={ask ?? t('rail.bg.stopAsk')}>
        {ask ? <span className="rp-ask-text">{ask}</span> : null}
        <button
          type="button"
          className="rp-mini is-danger"
          autoFocus
          onClick={() => {
            setPhase('stopping');
            Promise.resolve(onStop()).catch((e: unknown) => {
              setError(errorSentence(e));
              setPhase('idle');
            });
          }}
        >
          {t('rail.bg.yes')}
        </button>
        <button type="button" className="rp-mini" onClick={() => setPhase('idle')}>
          {t('rail.bg.no')}
        </button>
      </span>
    );
  }
  return (
    <>
      <button type="button" className="rp-stop" aria-label={t('rail.bg.stopNamed', { name })} title={t('rail.bg.stopNamed', { name })} disabled={phase === 'stopping'} onClick={() => setPhase('asking')}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="4" y="4" width="8" height="8" rx="1.5" />
        </svg>
      </button>
      {error ? <span className="rp-sr" role="alert">{error}</span> : null}
    </>
  );
}

export interface BackgroundSectionProps {
  helpers: readonly HelperRow[];
  /** Standbys set to "minion" that wait for this agent (no sidebar row): one quiet line, "N ready". */
  readyCount?: number;
  usage?: PaneUsage | null;
  /** The chat's own commands (a card or sheet that has no other agents). Left out when `commands` is given. */
  jobs?: readonly PaneJob[];
  /** Every command of the chat and of the agents below it, each with who ran it. */
  commands?: readonly CommandRow[];
  /** The last finished commands of the same agents. */
  finishedCommands?: readonly FinishedRow[];
  /** A command row was pressed: open its output in the details column. */
  onOpenCommand?: (row: CommandRow) => void;
  onOpenFinishedCommand?: (row: FinishedRow) => void;
  onOpenPane: (id: string) => void;
  /** A minion row was pressed: open its read-only view in the details column. Without it the row opens its pane. */
  onOpenTask?: (id: string) => void;
  /** The heading's open button: the full Background tasks page in the details column. */
  onOpenPage?: () => void;
  onStopHelper?: (id: string) => Promise<void> | void;
  /** Stops a command. `row` says whose it is (a card that has only its own agent's jobs gets none). */
  onStopJob: (pid: number, startedAtMs: number, row?: CommandRow) => Promise<void>;
  onPreview?: (port: number, external: boolean) => Promise<void> | void;
  onPointFix?: (port: number) => Promise<void> | void;
  onSaveTeam?: () => void;
  /** This chat's pane id and the name the person sees for it. Without the id, the rows cannot be put in the sidebar. */
  ownerId?: string;
  ownerName?: string;
  /** The other agents a minion can be handed to ("Hand to ..." in the row menu). */
  handTargets?: readonly { id: string; name: string }[];
  onHand?: (minion: HelperRow, toId: string) => void;
}

/** What one row's menu works on. */
interface RowMenu {
  place: TaskPlacement;
  minion: HelperRow | null;
  /** Stops it (the square asks first; this is the menu's own, which asks too). */
  stop: (() => Promise<void> | void) | null;
}

/** The owner of a job on a card that lists only its own agent's jobs. */
const OWN: CommandRow['owner'] = { id: '', name: '', agentType: null, status: '', self: true };

export function BackgroundSection({ helpers, readyCount = 0, usage, jobs = [], commands, finishedCommands = [], onOpenCommand, onOpenFinishedCommand, onOpenPane, onOpenTask, onOpenPage, onStopHelper, onStopJob, onPreview, onPointFix, onSaveTeam, ownerId, ownerName, handTargets = [], onHand }: BackgroundSectionProps) {
  const t = useT();
  const now = useClock(1000);
  const [showDone, setShowDone] = useState(false);
  const [menu, setMenu] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  /** Runs a preview action; says why under the rows when it fails. */
  const attempt = async (run: () => Promise<void> | void) => {
    setOpenError(null);
    try {
      await run();
    } catch (e) {
      setOpenError(errorSentence(e, t('state.jobs.couldNotOpen')));
    }
  };
  const anchor = useRef<HTMLElement | null>(null);
  // Rows that are also in the sidebar, the menu of one row, and the drop that sends a sidebar row back.
  const inSidebar = new Set(useTaskSidebar().map((r) => r.task_id));
  const [rowMenu, setRowMenu] = useState<RowMenu | null>(null);
  const rowAnchor = useRef<HTMLElement | null>(null);
  const bg = useRef<HTMLDivElement>(null);
  const canMove = ownerId !== undefined;
  const minionPlace = (h: HelperRow): TaskPlacement => ({ task_id: minionTaskId(h.id), kind: 'minion', owner: ownerId ?? '', under: ownerId ?? null, name: h.title, command: null });
  const jobPlace = (job: PaneJob): TaskPlacement => ({ task_id: jobTaskId(ownerId ?? '', job.pid, job.startedAtMs), kind: 'command', owner: ownerId ?? '', under: ownerId ?? null, name: job.name, command: job.command });
  const dragOf = (place: TaskPlacement) => (canMove ? dragSourceProps({ kind: 'bgtask', id: place.task_id, label: place.name, meta: { owner: place.owner, kind: place.kind, ownerName: ownerName ?? '' } }) : {});
  const openRowMenu = (el: HTMLElement, m: RowMenu) => {
    rowAnchor.current = el;
    setRowMenu(m);
  };
  const menuOf = (h: HelperRow): RowMenu => ({ place: minionPlace(h), minion: h, stop: onStopHelper ? () => onStopHelper(h.id) : null });
  const jobMenuOf = (job: PaneJob, row?: CommandRow): RowMenu => ({ place: jobPlace(job), minion: null, stop: () => onStopJob(job.pid, job.startedAtMs, row) });
  const onRowContext = (e: MouseEvent<HTMLElement>, m: RowMenu) => {
    if (!canMove) return;
    e.preventDefault();
    e.stopPropagation();
    openRowMenu(e.currentTarget, m);
  };
  // The Menu key and Shift+F10 raise the contextmenu event themselves in a browser; this covers the ones that arrive as keys only.
  const onRowKey = (e: KeyboardEvent<HTMLElement>, m: RowMenu) => {
    if (canMove && ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu')) {
      e.preventDefault();
      openRowMenu(e.currentTarget, m);
    }
  };
  const zoneId = `bg-back-${ownerId ?? 'none'}`;
  useEffect(() => {
    if (!canMove) return undefined;
    return registerDropZone({
      id: zoneId,
      priority: 7,
      accepts: (p) => p.kind === 'bgtask',
      getRect: () => bg.current?.getBoundingClientRect() ?? null,
      onDrop: (p) => {
        void removeTaskFromSidebar(p.id)
          .then(() => announce(t('taskdrag.announce.back', { task: p.label })))
          .catch(() => undefined);
      },
    });
  }, [canMove, zoneId, t]);
  const dropHere = useDragOver(zoneId);
  const open = (h: HelperRow) => (h.kind === 'minion' && onOpenTask ? onOpenTask(h.id) : onOpenPane(h.id));
  const busy = new Map((usage?.helpers ?? []).map((u) => [u.paneId, u.busyMs] as const));

  const live = helpers.filter((h) => isRunning(h.status) || isWaiting(h.status));
  const finished = helpers.filter((h) => !isRunning(h.status) && !isWaiting(h.status));
  const rows: readonly CommandRow[] = commands ?? jobs.map((job) => ({ key: String(job.pid), job, owner: OWN }));
  const by = showsBy(rows);
  const running = live.length + rows.length;
  const doneCount = finished.length + finishedCommands.length;
  const summary = running > 0 ? t('rail.bg.running', { n: running }) : doneCount > 0 ? t('rail.bg.finished', { n: doneCount }) : readyCount > 0 ? t('rail.bg.ready', { n: readyCount }) : t('rail.bg.none');

  const onContext = (e: MouseEvent<HTMLElement>) => {
    if (!onSaveTeam || helpers.length === 0) return;
    e.preventDefault();
    anchor.current = e.currentTarget;
    setMenu(true);
  };

  const item = (testid: string, label: string, run: () => void) => (
    <button
      type="button"
      role="menuitem"
      className="ck-menu-item"
      data-testid={testid}
      onClick={() => {
        setRowMenu(null);
        run();
      }}
    >
      {label}
    </button>
  );

  return (
    <RailSection id="bg" title={t('rail.bg.title')} summary={summary} action={onOpenPage ? { label: t('rail.bg.openPage'), onClick: onOpenPage } : undefined}>
      <div ref={bg} onContextMenu={onContext} className={`rp-bg${dropHere ? ' is-drop-target' : ''}`} data-testid="bg-section">
        {running === 0 && doneCount === 0 && readyCount === 0 && <div className="rp-row is-empty">{t('rail.bg.empty')}</div>}
        {live.map((h) => (
          <div key={h.id} className="rp-helper">
          <div
            className="rp-row rp-hov"
            data-testid="rail-helper"
            data-task-id={minionTaskId(h.id)}
            {...(h.kind === 'minion' ? dragOf(minionPlace(h)) : {})}
            onContextMenu={h.kind === 'minion' ? (e) => onRowContext(e, menuOf(h)) : undefined}
            onKeyDown={h.kind === 'minion' ? (e) => onRowKey(e, menuOf(h)) : undefined}
          >
            <button type="button" className="rp-row-main" title={h.agent ?? h.title} onClick={() => open(h)}>
              <AgentLogo id={h.agentType ?? ''} name={h.agent ?? h.title} size={16} decorative />
              <span className="rp-name">{h.title}</span>
              {isWaiting(h.status) ? <span className="rp-v is-warn rp-small">{t('rail.bg.needsYou')}</span> : <span className="rp-time">{clockText(rowElapsedMs(h, now, busy.get(h.id) ?? 0))}</span>}
              {inSidebar.has(minionTaskId(h.id)) && (
                <span className="rp-insb" data-testid="in-sidebar-mark" title={t('taskdrag.inSidebarTip')}>
                  {t('taskdrag.inSidebar')}
                </span>
              )}
            </button>
            {onStopHelper && <StopSquare name={h.title} onStop={() => onStopHelper(h.id)} />}
          </div>
          {isRunning(h.status) && <StallNotice paneId={h.id} compact />}
          </div>
        ))}
        {rows.map((row) => {
          const { job, owner } = row;
          const name = commandName(job, t);
          const mine = row.owner.self;
          const waiting = job.source !== 'terminal' && owner.status === 'running';
          return (
            <div
              key={row.key}
              className="rp-row rp-hov"
              data-testid="background-job"
              data-task-id={mine ? jobTaskId(ownerId ?? '', job.pid, job.startedAtMs) : undefined}
              title={job.command}
              {...(mine ? dragOf(jobPlace(job)) : {})}
              onContextMenu={mine ? (e) => onRowContext(e, jobMenuOf(job, row)) : undefined}
              onKeyDown={mine ? (e) => onRowKey(e, jobMenuOf(job, row)) : undefined}
            >
              <span className="rp-pulse" aria-hidden="true" />
              <span className="rp-stack">
                {onOpenCommand ? (
                  <button type="button" className="rp-name rp-mono rp-small rp-open" title={t('state.jobs.processTitle', { command: job.command, pid: job.pid })} onClick={() => onOpenCommand(row)}>
                    {name}
                  </button>
                ) : (
                  <span className="rp-name rp-mono rp-small" title={t('state.jobs.processTitle', { command: job.command, pid: job.pid })}>
                    {name}
                  </span>
                )}
                {by && owner.name ? (
                  <span className="rp-by" data-testid="command-by" title={t('rail.bg.byTip', { name: owner.name })}>
                    {owner.agentType ? <AgentLogo id={owner.agentType} name={owner.name} size={12} decorative /> : null}
                    <span className="rp-by-name">{t('rail.bg.by', { name: owner.name })}</span>
                  </span>
                ) : null}
              </span>
              {job.ports.map((port) => (
                <button
                  key={port}
                  type="button"
                  className="rp-port"
                  title={onPreview ? t('state.jobs.previewPort', { port }) : t('state.jobs.openPort', { port })}
                  onClick={(e) => void attempt(() => onPreview?.(port, e.shiftKey))}
                >
                  :{port}
                </button>
              ))}
              {onPointFix &&
                job.ports.map((port) => (
                  <button key={`point-${port}`} type="button" className="rp-port rp-on-hover" title={t('state.jobs.pointFix', { port })} aria-label={t('state.jobs.pointFix', { port })} onClick={() => void attempt(() => onPointFix(port))}>
                    {t('state.jobs.point')}
                  </button>
                ))}
              <span className="rp-time">{runTime(job.startedAtMs, now)}</span>
              {mine && inSidebar.has(jobTaskId(ownerId ?? '', job.pid, job.startedAtMs)) && (
                <span className="rp-insb" data-testid="in-sidebar-mark" title={t('taskdrag.inSidebarTip')}>
                  {t('taskdrag.inSidebar')}
                </span>
              )}
              {canStop(job) && <StopSquare name={name} ask={waiting ? t('rail.bg.stopWaiting', { name: owner.name || t('rail.bg.theAgent') }) : undefined} onStop={() => onStopJob(job.pid, job.startedAtMs, row)} />}
            </div>
          );
        })}
        {readyCount > 0 && (
          <div className="rp-row" data-testid="rail-ready">
            <span className="rp-name">{t('rail.bg.ready', { n: readyCount })}</span>
          </div>
        )}
        {doneCount > 0 && (
          <button type="button" className="rp-row rp-more" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
            {t('rail.bg.finished', { n: doneCount })}
          </button>
        )}
        {showDone &&
          finished.map((h) => (
            <button key={h.id} type="button" className="rp-row rp-sub" data-testid="rail-helper-done" onClick={() => open(h)}>
              <AgentLogo id={h.agentType ?? ''} name={h.agent ?? h.title} size={14} decorative />
              <span className="rp-name">{h.title}</span>
              {h.status === 'error' ? (
                <span className="rp-v is-bad rp-small">{t('rail.bg.failed')}</span>
              ) : (
                <span className="rp-time">{t('rail.bg.doneIn', { time: clockText(busy.get(h.id) ?? 0) })}</span>
              )}
            </button>
          ))}
        {showDone &&
          finishedCommands.map((row) => (
            <button key={row.key} type="button" className="rp-row rp-sub" data-testid="rail-command-done" title={row.done.command} onClick={() => onOpenFinishedCommand?.(row)}>
              <span className="rp-name rp-mono rp-small">{commandName(row.done, t)}</span>
              {!row.owner.self && row.owner.name ? <span className="rp-by">{t('rail.bg.by', { name: row.owner.name })}</span> : null}
              {row.done.state === 'failed' ? (
                <span className="rp-v is-bad rp-small">{t('rail.bg.failed')}</span>
              ) : row.done.state === 'stopped' ? (
                <span className="rp-time">{t('task.stopped')}</span>
              ) : (
                <span className="rp-time">{t('rail.bg.doneIn', { time: clockText(row.done.endedAtMs - row.done.startedAtMs) })}</span>
              )}
            </button>
          ))}
        {openError && (
          <p className="rp-note" role="alert">
            {openError}
          </p>
        )}
      </div>
      {rowMenu && (
        <FloatingMenu anchorRef={rowAnchor} align="start" label={t('taskdrag.menu.label')} onClose={() => setRowMenu(null)}>
          {inSidebar.has(rowMenu.place.task_id)
            ? item('bg-menu-back', t('taskdrag.menu.back'), () => {
                void removeTaskFromSidebar(rowMenu.place.task_id)
                  .then(() => announce(t('taskdrag.announce.back', { task: rowMenu.place.name })))
                  .catch(() => undefined);
              })
            : item('bg-menu-show', t('taskdrag.menu.show'), () => {
                void showTaskInSidebar(rowMenu.place)
                  .then(() => announce(t('taskdrag.announce.under', { task: rowMenu.place.name, name: ownerName ?? '' })))
                  .catch(() => undefined);
              })}
          {rowMenu.minion && onHand && handTargets.map((to) => item(`bg-menu-hand-${to.id}`, t('taskdrag.menu.handTo', { name: to.name }), () => rowMenu.minion && onHand(rowMenu.minion, to.id)))}
          {rowMenu.stop && item('bg-menu-stop', t('taskdrag.menu.stop'), () => void rowMenu.stop?.())}
        </FloatingMenu>
      )}
      {menu && onSaveTeam && (
        <FloatingMenu anchorRef={anchor} align="start" label={t('rail.bg.title')} onClose={() => setMenu(false)}>
          <button
            type="button"
            role="menuitem"
            className="ck-menu-item"
            title={t('rail.bg.saveTeamTip')}
            onClick={() => {
              setMenu(false);
              onSaveTeam();
            }}
          >
            {t('rail.bg.saveTeam')}
          </button>
        </FloatingMenu>
      )}
    </RailSection>
  );
}
