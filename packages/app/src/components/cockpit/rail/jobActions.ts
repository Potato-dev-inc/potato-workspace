// Helpers shared by the right panel's Background tasks section and the sheet that lists the jobs of every pane.
import { refreshJobs, type JobsApi } from '../../../lib/pane-jobs';
import { openPreview } from '../../../lib/pane-preview';
import { pointApi } from '../../../lib/point-api';

/** Stop `pid` of `paneId` (the process that started at `startedAtMs`), then look again at once so the row goes away without waiting. */
export const stopJob = (api: JobsApi, paneId: string, pid: number, startedAtMs: number): Promise<void> =>
  api.stop(paneId, pid, startedAtMs).then(() => refreshJobs());

/** Stops a command row: a terminal the app hosts by its id, any other by its process (and the start time it was listed with). */
export const stopCommand = (api: JobsApi, owner: string, job: { pid: number; startedAtMs: number; terminalId?: string }): Promise<void> =>
  job.terminalId && api.stopTerminal ? api.stopTerminal(job.terminalId).then(() => refreshJobs()) : stopJob(api, owner, job.pid, job.startedAtMs);

/** A port of one of `paneId`'s jobs: the in-app preview (`armed` starts the picker), or your browser when `external`. */
export const previewJobPort = (paneId: string, port: number, external: boolean, armed = false): Promise<void> =>
  external ? openPreview(`http://localhost:${port}/`) : pointApi.openPreview(paneId, port, armed).then(() => undefined);
