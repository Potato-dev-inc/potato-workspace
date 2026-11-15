// Background tasks: everything running for this chat, one row each. Helpers (logo, name), commands (pulsing dot, the
// command in mono), with the time it ran and a small stop square that asks once. A helper waiting on the person says
// "Needs you". The last row, "N finished", opens the list of the ones that are done. "Save this team" is in the
// section's right-click menu.
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useT } from '../../../i18n';
import { runTime, type PaneJob } from '../../../lib/pane-jobs';
import { errorSentence } from '../../../lib/sayError';
import type { PaneUsage } from '../../../lib/pane-usage';
import { AgentLogo } from '../../common/AgentLogo';
import { FloatingMenu } from '../FloatingMenu';
import { RailSection } from './RailSection';
import { clockText } from './railFormat';

export interface HelperRow {
  id: string;
  title: string;
  agent: string | null;
  /** The agent's id, for its logo. */
  agentType?: string | null;
  status: string;
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
function StopSquare({ name, onStop }: { name: string; onStop: () => Promise<void> | void }) {
  const t = useT();
  const [phase, setPhase] = useState<'idle' | 'asking' | 'stopping'>('idle');
  const [error, setError] = useState<string | null>(null);
  if (phase === 'asking') {
    return (
      <span className="rp-ask" role="group" aria-label={t('rail.bg.stopAsk')}>
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
  usage?: PaneUsage | null;
  jobs: readonly PaneJob[];
  onOpenPane: (id: string) => void;
  onStopHelper?: (id: string) => Promise<void> | void;
  onStopJob: (pid: number, startedAtMs: number) => Promise<void>;
  onPreview?: (port: number, external: boolean) => Promise<void> | void;
  onPointFix?: (port: number) => Promise<void> | void;
  onSaveTeam?: () => void;
}

export function BackgroundSection({ helpers, usage, jobs, onOpenPane, onStopHelper, onStopJob, onPreview, onPointFix, onSaveTeam }: BackgroundSectionProps) {
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
  const busy = new Map((usage?.helpers ?? []).map((u) => [u.paneId, u.busyMs] as const));

  const live = helpers.filter((h) => isRunning(h.status) || isWaiting(h.status));
  const finished = helpers.filter((h) => !isRunning(h.status) && !isWaiting(h.status));
  const running = live.length + jobs.length;
  const summary = running > 0 ? t('rail.bg.running', { n: running }) : finished.length > 0 ? t('rail.bg.finished', { n: finished.length }) : t('rail.bg.none');

  const onContext = (e: MouseEvent<HTMLElement>) => {
    if (!onSaveTeam || helpers.length === 0) return;
    e.preventDefault();
    anchor.current = e.currentTarget;
    setMenu(true);
  };

  return (
    <RailSection id="bg" title={t('rail.bg.title')} summary={summary}>
      <div onContextMenu={onContext} className="rp-bg">
        {running === 0 && finished.length === 0 && <div className="rp-row is-empty">{t('rail.bg.empty')}</div>}
        {live.map((h) => (
          <div key={h.id} className="rp-row rp-hov" data-testid="rail-helper">
            <button type="button" className="rp-row-main" title={h.agent ?? h.title} onClick={() => onOpenPane(h.id)}>
              <AgentLogo id={h.agentType ?? ''} name={h.agent ?? h.title} size={16} decorative />
              <span className="rp-name">{h.title}</span>
              {isWaiting(h.status) ? <span className="rp-v is-warn rp-small">{t('rail.bg.needsYou')}</span> : <span className="rp-time">{clockText(busy.get(h.id) ?? 0)}</span>}
            </button>
            {onStopHelper && <StopSquare name={h.title} onStop={() => onStopHelper(h.id)} />}
          </div>
        ))}
        {jobs.map((job) => (
          <div key={job.pid} className="rp-row rp-hov" data-testid="background-job" title={job.command}>
            <span className="rp-pulse" aria-hidden="true" />
            <span className="rp-name rp-mono rp-small" title={t('state.jobs.processTitle', { command: job.command, pid: job.pid })}>
              {job.name}
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
            <StopSquare name={job.name} onStop={() => onStopJob(job.pid, job.startedAtMs)} />
          </div>
        ))}
        {finished.length > 0 && (
          <button type="button" className="rp-row rp-more" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
            {t('rail.bg.finished', { n: finished.length })}
          </button>
        )}
        {showDone &&
          finished.map((h) => (
            <button key={h.id} type="button" className="rp-row rp-sub" onClick={() => onOpenPane(h.id)}>
              <AgentLogo id={h.agentType ?? ''} name={h.agent ?? h.title} size={14} decorative />
              <span className="rp-name">{h.title}</span>
              <span className="rp-time">{t('rail.bg.doneIn', { time: clockText(busy.get(h.id) ?? 0) })}</span>
            </button>
          ))}
        {openError && (
          <p className="rp-note" role="alert">
            {openError}
          </p>
        )}
      </div>
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
