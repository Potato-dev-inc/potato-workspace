// Test helper: the Background tasks section fed with one pane's jobs and a fake jobs API, like the rail does.
import type { JobsApi, PaneJob } from '../../../lib/pane-jobs';
import { BackgroundSection } from './BackgroundSection';
import { previewJobPort, stopJob } from './jobActions';

export function JobsOnly({ paneId, jobs, api }: { paneId: string; jobs: readonly PaneJob[]; api: JobsApi }) {
  return (
    <BackgroundSection
      helpers={[]}
      jobs={jobs}
      onOpenPane={() => {}}
      onStopJob={(pid, startedAtMs) => stopJob(api, paneId, pid, startedAtMs)}
      onPreview={(port, external) => previewJobPort(paneId, port, external)}
      onPointFix={(port) => previewJobPort(paneId, port, false, true)}
    />
  );
}
