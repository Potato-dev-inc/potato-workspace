// "3 background tasks" in the sidebar footer: it counts the background jobs of every pane and opens a
// sheet that lists them grouped by pane. Hidden when nothing runs in the background.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { jobCount, jobsOfPanes, jobsRunning, tauriJobsApi, usePaneJobs, type JobsApi, type JobsMap } from '../../../lib/pane-jobs';
import { useT } from '../../../i18n';
import { IconTerminal } from '../Icons';
import { Sheet } from '../Sheet';
import { previewJobPort, stopJob } from './jobActions';
import { BackgroundJobs } from './BackgroundJobs';
import { AgentLogo } from '../../common/AgentLogo';
import { errorSentence } from '../../../lib/sayError';
import type { HelperRow } from './BackgroundSection';

export interface JobsChipProps {
  /** Pane id to the name shown for it. */
  names: ReadonlyMap<string, string>;
  /** Open a pane (the sheet closes first). */
  onOpenPane: (id: string) => void;
  api?: JobsApi;
  /** The helpers a pane started, shown with its tasks (the same rows as the right panel's Background tasks). */
  helpersOf?: (paneId: string) => readonly HelperRow[];
  onStopHelper?: (id: string) => Promise<void> | void;
}

const isLive = (s: string) => s === 'running' || s === 'waiting_input';

/** One helper row in the list: logo, name, and a stop button. */
function HelperLine({ h, onOpen, onStop }: { h: HelperRow; onOpen: () => void; onStop?: (id: string) => Promise<void> | void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="ck-job" data-testid="jobs-helper">
      <button type="button" className="ck-job-stop" onClick={onOpen} title={h.agent ?? h.title}>
        <AgentLogo id={h.agentType ?? ''} name={h.agent ?? h.title} size={14} decorative /> {h.title}
        {h.status === 'waiting_input' ? ` · ${t('rail.bg.needsYou')}` : ''}
      </button>
      {onStop && (
        <button type="button" className="ck-job-stop" aria-label={t('rail.bg.stopNamed', { name: h.title })} onClick={() => void Promise.resolve(onStop(h.id)).catch((e: unknown) => setError(errorSentence(e)))}>
          {t('state.jobs.stop')}
        </button>
      )}
      {error && (
        <p className="ck-job-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function JobsSheet({ jobs, names, onOpenPane, onClose, api = tauriJobsApi, helpersOf, onStopHelper }: { jobs: JobsMap; onClose: () => void } & JobsChipProps) {
  const t = useT();
  const groups = Object.entries(jobs).filter(([, list]) => list.length > 0);
  // Nothing left to show (the last job stopped): the sheet goes away on its own.
  useEffect(() => {
    if (groups.length === 0) onClose();
  }, [groups.length, onClose]);
  // Drawn in the app's top layer: inside the sidebar the sheet's scrim only covered the footer, so the click looked dead.
  return createPortal(
    <Sheet labelledBy="ck-jobs-t" role="dialog" onClose={onClose} className="ck-sheet--jobs">
      <h2 className="ck-section" id="ck-jobs-t">
        {t('state.jobs.title')}
      </h2>
      <p className="ck-sub">{t('state.jobs.sub')}</p>
      <div className="ck-jobs-groups">
        {groups.map(([paneId, list]) => (
          <section key={paneId} className="ck-jobs-group" aria-label={names.get(paneId) ?? t('state.jobs.agent')}>
            <div className="ck-jobs-group-h">
              <span>{names.get(paneId) ?? t('state.jobs.agent')}</span>
              <button
                type="button"
                className="ck-job-stop"
                onClick={() => {
                  onClose();
                  onOpenPane(paneId);
                }}
              >
                {t('state.jobs.open')}
              </button>
            </div>
            {(helpersOf?.(paneId) ?? [])
              .filter((h) => isLive(h.status))
              .map((h) => (
                <HelperLine
                  key={h.id}
                  h={h}
                  onOpen={() => {
                    onClose();
                    onOpenPane(h.id);
                  }}
                  onStop={onStopHelper}
                />
              ))}
            <BackgroundJobs
              jobs={list}
              onStop={(pid, startedAtMs) => stopJob(api, paneId, pid, startedAtMs)}
              onPreview={(port, external) => previewJobPort(paneId, port, external)}
              onPointFix={(port) => previewJobPort(paneId, port, false, true)}
            />
          </section>
        ))}
      </div>
      <div className="ck-sheet-actions">
        <button type="button" className="ck-btn ck-btn--secondary" onClick={onClose}>
          {t('state.jobs.close')}
        </button>
      </div>
    </Sheet>,
    document.querySelector('.cockpit') ?? document.body,
  );
}

export function JobsChip({ names, onOpenPane, api = tauriJobsApi, helpersOf, onStopHelper }: JobsChipProps) {
  const t = useT();
  const all = usePaneJobs(api);
  // Only the panes the sidebar lists: with no agents there is nothing running to count.
  const jobs = jobsOfPanes(all, names.keys());
  const [open, setOpen] = useState(false);
  const count = jobCount(jobs);
  if (count === 0) return null;
  return (
    <>
      <button type="button" className="ck-btn ck-btn--plain ck-jobs-chip" onClick={() => setOpen(true)} data-testid="jobs-chip" title={t('state.jobs.chipTitle')}>
        <IconTerminal />
        {jobsRunning(count)}
      </button>
      {open && <JobsSheet jobs={jobs} names={names} onOpenPane={onOpenPane} onClose={() => setOpen(false)} api={api} helpersOf={helpersOf} onStopHelper={onStopHelper} />}
    </>
  );
}
