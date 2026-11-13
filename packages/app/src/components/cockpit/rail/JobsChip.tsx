// "3 background tasks" in the sidebar footer: it counts the background jobs of every pane and opens a
// sheet that lists them grouped by pane. Hidden when nothing runs in the background.
import { useEffect, useState } from 'react';
import { jobCount, jobsOfPanes, jobsRunning, tauriJobsApi, usePaneJobs, type JobsApi, type JobsMap } from '../../../lib/pane-jobs';
import { useT } from '../../../i18n';
import { IconTerminal } from '../Icons';
import { Sheet } from '../Sheet';
import { previewJobPort, stopJob } from './BackgroundCard';
import { BackgroundJobs } from './BackgroundJobs';

export interface JobsChipProps {
  /** Pane id to the name shown for it. */
  names: ReadonlyMap<string, string>;
  /** Open a pane (the sheet closes first). */
  onOpenPane: (id: string) => void;
  api?: JobsApi;
}

export function JobsSheet({ jobs, names, onOpenPane, onClose, api = tauriJobsApi }: { jobs: JobsMap; onClose: () => void } & JobsChipProps) {
  const t = useT();
  const groups = Object.entries(jobs).filter(([, list]) => list.length > 0);
  // Nothing left to show (the last job stopped): the sheet goes away on its own.
  useEffect(() => {
    if (groups.length === 0) onClose();
  }, [groups.length, onClose]);
  return (
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
    </Sheet>
  );
}

export function JobsChip({ names, onOpenPane, api = tauriJobsApi }: JobsChipProps) {
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
      {open && <JobsSheet jobs={jobs} names={names} onOpenPane={onOpenPane} onClose={() => setOpen(false)} api={api} />}
    </>
  );
}
