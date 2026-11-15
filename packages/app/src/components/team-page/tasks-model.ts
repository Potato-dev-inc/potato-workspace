// The Pass a task rules, pure: byte counts, what blocks sending, which buttons a task shows, the words for each state.
import { t } from '../../i18n';
import { durationWords, HOUR, type LendProfile, type LendState } from '../../lib/lend';
import type { RecvTask, RepoCheck, RepoHistory, SentTask, TasksView } from '../../lib/team-tasks';

/** The most a task text can be, in UTF-8 bytes (the Rust side checks the same number). */
export const TEXT_MAX_BYTES = 8_000;
/** The most a chat summary can be, in UTF-8 bytes. */
export const SUMMARY_MAX_BYTES = 2_000;
export const TITLE_MAX = 100;
/** The note on "done", in characters. */
export const NOTE_MAX = 280;
/** A lend that goes with a task is never longer than a day (it goes to another person). */
export const TASK_LEND_CAP_SECS = 24 * HOUR;

const encoder = new TextEncoder();
export const byteLength = (s: string): number => encoder.encode(s).length;

/** "1.5 MB", "480 KB", "90 bytes". */
export function sizeWords(bytes: number): string {
  if (bytes >= 1024 * 1024) return t('teamHub.pass.mb', { n: (bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '') });
  if (bytes >= 1024) return t('teamHub.pass.kb', { n: Math.round(bytes / 1024) });
  return t('teamHub.pass.bytes', { n: bytes });
}

export type RepoChoice = 'words' | 'repo';

/** Why "the words and a copy of this repo" cannot be chosen, as a plain sentence; null when it can. */
export function repoDisabledReason(o: { handoverOn: boolean; folder: string | null; check: RepoCheck | null; checking: boolean }): string | null {
  if (!o.handoverOn) return t('teamHub.pass.repo.off');
  if (!o.folder) return t('teamHub.pass.repo.noFolder');
  if (o.checking) return t('teamHub.pass.repo.checking');
  if (!o.check) return t('teamHub.pass.repo.noFolder');
  if (!o.check.ok) return o.check.reason || t('teamHub.pass.repo.notGit');
  return null;
}

export interface PassDraft {
  toMember: string | null;
  title: string;
  text: string;
  summaryOn: boolean;
  summary: string;
  choice: RepoChoice;
  history: RepoHistory;
  understood: boolean;
}

/** What is wrong with the sheet right now, as a plain sentence; null when it can be sent. */
export function passProblem(d: PassDraft): string | null {
  if (!d.toMember) return t('teamHub.pass.err.who');
  if (d.title.trim() === '') return t('teamHub.pass.err.title');
  if (d.text.trim() === '') return t('teamHub.pass.err.text');
  if (byteLength(d.text) > TEXT_MAX_BYTES) return t('teamHub.pass.err.textLong', { max: TEXT_MAX_BYTES.toLocaleString('en-US') });
  if (d.summaryOn && byteLength(d.summary) > SUMMARY_MAX_BYTES) return t('teamHub.pass.err.summaryLong', { max: SUMMARY_MAX_BYTES.toLocaleString('en-US') });
  if (d.choice === 'repo' && !d.understood) return t('teamHub.pass.err.understood');
  return null;
}

/** A lend profile that may be lent to a teammate along with a task. */
export function lendableProfiles(lend: LendState | null | undefined, member: string | null): LendProfile[] {
  if (!lend || !lend.enabled) return [];
  return lend.profiles.filter((p) => p.who === 'teammates' && (p.member_ids.length === 0 || (member !== null && p.member_ids.includes(member))));
}

/** The lengths offered for a profile: one, two, four, eight and 24 hours, never more than it allows or a day. */
export function lendChoices(p: Pick<LendProfile, 'max_secs'>): number[] {
  const cap = Math.min(p.max_secs, TASK_LEND_CAP_SECS);
  return [1, 2, 4, 8, 24].map((h) => h * HOUR).filter((s) => s <= cap);
}

export const lendWords = (profile: string, secs: number): string => t('teamHub.pass.lend.mine', { profile, time: durationWords(secs) });

// ---- received tasks --------------------------------------------------------------------------------------------

export type RecvAction = 'accept' | 'decline' | 'start' | 'done';

/** Which buttons a received task shows, in order. */
export function recvActions(task: Pick<RecvTask, 'state'>): RecvAction[] {
  switch (task.state) {
    case 'new':
    case 'seen':
      return ['accept', 'decline'];
    case 'accepted':
      return ['start', 'done'];
    case 'started':
      return ['done'];
    default:
      return [];
  }
}

/** A closed task is a small row: done, declined, taken back. */
export const recvClosed = (task: Pick<RecvTask, 'state'>): boolean => task.state === 'done' || task.state === 'declined' || task.state === 'withdrawn';

/** Waiting for my answer. */
export const recvWaiting = (task: Pick<RecvTask, 'state'>): boolean => task.state === 'new' || task.state === 'seen';

/** Received tasks that wait for me (the number on the Tasks tab). */
export const waitingCount = (view: Pick<TasksView, 'received'> | null | undefined): number => view?.received.filter(recvWaiting).length ?? 0;

/** Why "Also get the repo" cannot be ticked; null when it can. */
export function acceptRepoReason(handoverOn: boolean): string | null {
  return handoverOn ? null : t('teamHub.tasks.accept.repoOff');
}

/** Is the lend choice offered on Accept? Only when the task has a lend offer and lending is on. */
export const lendOffered = (task: Pick<RecvTask, 'lend'>, lendOn: boolean): boolean => lendOn && task.lend !== null;

// ---- sent tasks -----------------------------------------------------------------------------------------------

const SENT_CHIP = {
  sent: 'teamHub.tasks.chip.sent',
  seen: 'teamHub.tasks.chip.seen',
  accepted: 'teamHub.tasks.chip.accepted',
  started: 'teamHub.tasks.chip.started',
  done: 'teamHub.tasks.chip.done',
  declined: 'teamHub.tasks.chip.declined',
  withdrawn: 'teamHub.tasks.chip.withdrawn',
} as const;

export const sentChip = (state: SentTask['state']): string => t(SENT_CHIP[state]);

/** "Take back" is offered until the other person starts. */
export const canTakeBack = (task: Pick<SentTask, 'state'>): boolean => task.state === 'sent' || task.state === 'seen' || task.state === 'accepted';

/** The repo line on a sent task: "Sending the repo 3/12", or null. */
export function sentRepoLine(task: Pick<SentTask, 'repo' | 'repoState' | 'repoSent' | 'repoError'>): string | null {
  if (!task.repo) return null;
  switch (task.repoState) {
    case 'waiting':
      return t('teamHub.tasks.repo.waiting');
    case 'sending':
      return t('teamHub.tasks.repo.sending', { got: task.repoSent, total: task.repo.chunks });
    case 'sent':
      return t('teamHub.tasks.repo.sent');
    case 'failed':
      return task.repoError || t('teamHub.tasks.repo.failed');
    default:
      return null;
  }
}

/** "Comes with: repo potato (480 KB, main) · Claude for 2 hours". Null when nothing comes with it. */
export function comesWith(task: Pick<RecvTask, 'repo' | 'lend'>, lendOn = true): string | null {
  const parts: string[] = [];
  if (task.repo) parts.push(t('teamHub.tasks.with.repo', { name: task.repo.name, size: sizeWords(task.repo.bytes), branch: task.repo.branch }));
  if (task.lend && lendOn) parts.push(t('teamHub.tasks.with.lend', { profile: task.lend.profileName, time: durationWords(task.lend.secs) }));
  return parts.length ? parts.join(' · ') : null;
}

/** Texts longer than this fold behind "Read all". */
export const CLAMP_CHARS = 280;
