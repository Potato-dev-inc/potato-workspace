// The list of background jobs of one pane: name, the ports it listens on, how long it has run and a Stop button
// on ONE line (the full command is the row's hover text; Point shows on hover or focus) that asks once ("Stop this job?"). Shared by the Session
// rail's card and the sheet that lists the jobs of every pane.
import { useEffect, useState } from 'react';
import { openPreview } from '../../../lib/pane-preview';
import { runTime, type PaneJob } from '../../../lib/pane-jobs';
import '../../../styles/cockpit-jobs.css';

/** A clock that moves every `ms` so run times stay fresh between polls. */
function useClock(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const portUrl = (port: number): string => `http://localhost:${port}/`;

/** Puts the reason under the row when an open or a stop fails. */
const reasonOf = (e: unknown, fallback: string): string => (typeof e === 'string' ? e : e instanceof Error ? e.message : fallback);

interface PreviewActions {
  /** Port chip: the in-app preview. Shift+click passes `external` = true (your browser). Without it the chip opens the browser. */
  onPreview?: (port: number, external: boolean) => Promise<void> | void;
  /** "Point" button: the in-app preview with the picker on (Point and Fix). Shown only when given. */
  onPointFix?: (port: number) => Promise<void> | void;
}

function JobRow({ job, now, onStop, onPreview, onPointFix }: { job: PaneJob; now: number; onStop: (pid: number, startedAtMs: number) => Promise<void> } & PreviewActions) {
  const [phase, setPhase] = useState<'idle' | 'asking' | 'stopping'>('idle');
  const [error, setError] = useState<string | null>(null);
  const stop = () => {
    setPhase('stopping');
    setError(null);
    onStop(job.pid, job.startedAtMs)
      .catch((e: unknown) => {
        setError(reasonOf(e, 'Could not stop this job.'));
        setPhase('idle');
      });
  };
  const open = async (run: () => Promise<void> | void) => {
    setError(null);
    try {
      await run();
    } catch (e) {
      setError(reasonOf(e, 'Could not open the preview.'));
    }
  };
  return (
    <li className="ck-job" data-testid="background-job">
      <div className="ck-job-top" title={job.command}>
        <span className="ck-job-name" title={`${job.command} (process ${job.pid})`}>
          {job.name}
        </span>
        {job.ports.map((port) => (
          <button
            key={port}
            type="button"
            className="ck-job-port"
            title={onPreview ? `Preview :${port} (Shift+click: your browser)` : `Open localhost:${port} in your browser`}
            onClick={(e) => void open(() => (onPreview ? onPreview(port, e.shiftKey) : openPreview(portUrl(port))))}
          >
            :{port}
          </button>
        ))}
        <span className="ck-job-time" title="How long it has run">
          {runTime(job.startedAtMs, now)}
        </span>
        {/* Hover or keyboard focus on the row shows these; the buttons are always in the tab order. */}
        {onPointFix &&
          job.ports.map((port) => (
            <button
              key={`point-${port}`}
              type="button"
              className="ck-job-point ck-job-hover"
              title={`Point and fix on localhost:${port}`}
              aria-label={`Point and fix on localhost:${port}`}
              onClick={() => void open(() => onPointFix(port))}
            >
              Point
            </button>
          ))}
        {phase === 'idle' && (
          <button type="button" className="ck-job-stop" onClick={() => setPhase('asking')} aria-label={`Stop ${job.name}`}>
            Stop
          </button>
        )}
        {phase === 'stopping' && <span className="ck-job-time">Stopping…</span>}
      </div>
      {phase === 'asking' && (
        <div className="ck-job-ask" role="group" aria-label="Stop this job?">
          <span>Stop this job?</span>
          <button type="button" className="ck-job-stop is-danger" onClick={stop} autoFocus>
            Yes
          </button>
          <button type="button" className="ck-job-stop" onClick={() => setPhase('idle')}>
            No
          </button>
        </div>
      )}
      {error && (
        <p className="ck-job-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export function BackgroundJobs({
  jobs,
  onStop,
  onPreview,
  onPointFix,
}: { jobs: readonly PaneJob[]; onStop: (pid: number, startedAtMs: number) => Promise<void> } & PreviewActions) {
  const now = useClock(10_000);
  return (
    <ul className="ck-jobs">
      {jobs.map((job) => (
        <JobRow key={job.pid} job={job} now={now} onStop={onStop} onPreview={onPreview} onPointFix={onPointFix} />
      ))}
    </ul>
  );
}
