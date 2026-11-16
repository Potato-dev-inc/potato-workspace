// The full Background tasks page, in the details column: "Running N" as one card per owner (each minion, helper, and the
// chat's own agent) with the commands it left running, and "Finished N" folded at the bottom. This is the one place
// where the real command text is shown on the top level: it is there to be read, never to be typed.
import { useEffect, useState } from 'react';
import { useT } from '../../../i18n';
import { runTime, usePaneJobs, type PaneJob } from '../../../lib/pane-jobs';
import type { PaneUsage } from '../../../lib/pane-usage';
import { AgentLogo } from '../../common/AgentLogo';
import { rowElapsedMs, StopSquare, type HelperRow } from './BackgroundSection';
import { clockText } from './railFormat';

const isLive = (s: string) => s === 'running' || s === 'waiting_input';

function useClock(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function JobLine({ job, now, onStop }: { job: PaneJob; now: number; onStop: () => Promise<void> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <li className="tk-job" data-testid="task-job">
      <div className="tk-job-row">
        <button type="button" className="tk-job-main" aria-expanded={open} onClick={() => setOpen(!open)} title={job.command}>
          <span className="tk-mono tk-job-name">{job.name}</span>
          <span className="tk-time">{runTime(job.startedAtMs, now)}</span>
        </button>
        <StopSquare name={job.name} onStop={onStop} />
      </div>
      {open && (
        <div className="tk-job-open">
          <pre className="tk-mono tk-cmd">{job.command}</pre>
          <p className="tk-quiet">{t('task.noOutput')}</p>
        </div>
      )}
    </li>
  );
}

interface Group {
  id: string;
  title: string;
  agentType: string | null;
  /** The owner can be opened and stopped (a minion or helper). The chat's own agent cannot be stopped from here. */
  row: HelperRow | null;
  jobs: readonly PaneJob[];
  busyMs: number;
}

function Card({
  group,
  now,
  onOpen,
  onStopOwner,
  onStopJob,
}: {
  group: Group;
  now: number;
  onOpen?: () => void;
  onStopOwner?: () => Promise<void> | void;
  onStopJob: (owner: string, pid: number, startedAtMs: number) => Promise<void>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const waiting = group.row?.status === 'waiting_input';
  const sum = [t('task.tasks', { count: group.jobs.length }), t('task.nRunning', { n: group.jobs.length })].join(', ');
  return (
    <section className="tk-card" data-testid="task-group" aria-label={group.title}>
      <div className="tk-card-head">
        <button type="button" className="tk-card-title" onClick={onOpen} disabled={!onOpen} title={t('task.openOwner', { name: group.title })}>
          {group.agentType !== null && <AgentLogo id={group.agentType} name={group.title} size={16} decorative />}
          <span className="tk-name">{group.title}</span>
          {onOpen && (
            <span className="tk-go" aria-hidden="true">
              ›
            </span>
          )}
        </button>
        {waiting ? <span className="tk-warn">{t('rail.bg.needsYou')}</span> : <span className="tk-time">{clockText(group.busyMs)}</span>}
        {onStopOwner && <StopSquare name={group.title} onStop={onStopOwner} />}
      </div>
      {group.jobs.length > 0 && (
        <>
          <button
            type="button"
            className="tk-sum"
            aria-expanded={open}
            aria-label={open ? t('task.hideTasks', { name: group.title }) : t('task.showTasks', { name: group.title })}
            onClick={() => setOpen(!open)}
          >
            {sum}
            <span aria-hidden="true"> {open ? '⌄' : '›'}</span>
          </button>
          {open && (
            <ul className="tk-jobs">
              {group.jobs.map((job) => (
                <JobLine key={job.pid} job={job} now={now} onStop={() => onStopJob(group.id, job.pid, job.startedAtMs)} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export function BackgroundPage({
  paneId,
  agentName,
  agentType,
  rows,
  usage,
  onOpenOwner,
  onStopOwner,
  onStopJob,
  onOpenFinished,
}: {
  paneId: string;
  agentName: string;
  agentType: string;
  /** Minions and helpers of this chat that the person has not cleared. */
  rows: readonly HelperRow[];
  usage?: PaneUsage | null;
  onOpenOwner: (row: HelperRow) => void;
  onStopOwner?: (id: string) => Promise<void> | void;
  onStopJob: (owner: string, pid: number, startedAtMs: number) => Promise<void>;
  onOpenFinished: (row: HelperRow) => void;
}) {
  const t = useT();
  const now = useClock(1000);
  const jobs = usePaneJobs();
  const [showDone, setShowDone] = useState(false);
  const busy = new Map((usage?.helpers ?? []).map((u) => [u.paneId, u.busyMs] as const));
  const live = rows.filter((r) => isLive(r.status));
  const finished = rows.filter((r) => !isLive(r.status));
  const groups: Group[] = live.map((r) => ({ id: r.id, title: r.title, agentType: r.agentType ?? null, row: r, jobs: jobs[r.id] ?? [], busyMs: rowElapsedMs(r, now, busy.get(r.id) ?? 0) }));
  const own = jobs[paneId] ?? [];
  if (own.length > 0) groups.push({ id: paneId, title: agentName, agentType, row: null, jobs: own, busyMs: Math.max(0, ...own.map((j) => now - j.startedAtMs)) });
  return (
    <div className="tk-page" data-testid="background-page">
      {groups.length === 0 && <p className="tk-empty">{t('task.nothing')}</p>}
      {groups.length > 0 && (
        <>
          <h4 className="tk-h">{t('task.running', { n: groups.length })}</h4>
          {groups.map((g) => (
            <Card
              key={g.id}
              group={g}
              now={now}
              onOpen={g.row ? () => onOpenOwner(g.row!) : undefined}
              onStopOwner={g.row ? () => onStopOwner?.(g.id) : undefined}
              onStopJob={onStopJob}
            />
          ))}
        </>
      )}
      {finished.length > 0 && (
        <>
          <button type="button" className="tk-fold" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
            <span>{t('task.finished', { n: finished.length })}</span>
            <span aria-hidden="true">{showDone ? '⌄' : '›'}</span>
          </button>
          {showDone && (
            <ul className="tk-done">
              {finished.map((r) => (
                <li key={r.id}>
                  <button type="button" className="tk-done-row" data-testid="task-finished" onClick={() => onOpenFinished(r)}>
                    <AgentLogo id={r.agentType ?? ''} name={r.agent ?? r.title} size={14} decorative />
                    <span className="tk-name">{r.title}</span>
                    {r.status === 'error' ? <span className="tk-bad">{t('task.failed')}</span> : <span className="tk-time">{t('task.doneIn', { time: clockText(busy.get(r.id) ?? 0) })}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
