// The commands of a chat's Background tasks as rows: the commands of its own agent and of every agent below it, each
// with the owner that ran it ("by <name>"). Pure; the rail feeds it the shared jobs map and the owners.
import { jobKey, type FinishedCommand, type FinishedMap, type JobsMap, type PaneJob } from '../../../lib/pane-jobs';
import type { CommandOwner } from './helperRows';

export interface CommandRow {
  key: string;
  job: PaneJob;
  owner: CommandOwner;
}

export interface FinishedRow {
  key: string;
  done: FinishedCommand;
  owner: CommandOwner;
}

/** Newest first, as the plan orders commands. */
export function commandRows(map: JobsMap, owners: readonly CommandOwner[]): CommandRow[] {
  const rows: CommandRow[] = [];
  for (const owner of owners) {
    for (const job of map[owner.id] ?? []) rows.push({ key: `${owner.id}|${jobKey(job)}`, job, owner });
  }
  return rows.sort((a, b) => b.job.startedAtMs - a.job.startedAtMs);
}

/** The last 20 finished commands of the chat and its agents, newest first. */
export function finishedRows(map: FinishedMap, owners: readonly CommandOwner[], limit = 20): FinishedRow[] {
  const rows: FinishedRow[] = [];
  for (const owner of owners) {
    for (const done of map[owner.id] ?? []) rows.push({ key: `${owner.id}|${done.id}`, done, owner });
  }
  return rows.sort((a, b) => b.done.endedAtMs - a.done.endedAtMs).slice(0, limit);
}

/** "by" is shown on every row once any row belongs to another agent; with only the chat's own agent it is left out. */
export const showsBy = (rows: readonly CommandRow[]): boolean => rows.some((r) => !r.owner.self);
