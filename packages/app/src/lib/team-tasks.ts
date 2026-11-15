// "Pass a task to a teammate": the typed command surface. The Rust side (src-tauri/src/team) holds the tasks; this file
// only calls it. A teammate's words (title, text, summary, note, repo name) are untrusted: screens show them as plain text.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type RepoHistory = 'latest' | 'full';

export interface RepoOffer {
  name: string;
  branch: string;
  gitRef: string;
  history: RepoHistory;
  bytes: number;
  sha256: string;
  chunks: number;
}

export interface LendOffer {
  profileId: string;
  profileName: string;
  agentId: string;
  secs: number;
}

export type SentState = 'sent' | 'seen' | 'accepted' | 'declined' | 'started' | 'done' | 'withdrawn';
export type RecvState = 'new' | 'seen' | 'accepted' | 'declined' | 'started' | 'done' | 'withdrawn';
export type SentRepoState = 'none' | 'waiting' | 'sending' | 'sent' | 'failed';
export type RecvRepoState = 'none' | 'offered' | 'receiving' | 'ready' | 'unpacked' | 'failed';

export interface SentTask {
  id: string;
  toMember: string;
  toName: string;
  toDevices: string[];
  answeredDevice: string | null;
  title: string;
  text: string;
  summary: string;
  repo: RepoOffer | null;
  lend: LendOffer | null;
  lendUsed: boolean;
  state: SentState;
  atMs: number;
  updatedMs: number;
  note: string;
  repoState: SentRepoState;
  repoSent: number;
  repoError: string | null;
}

export interface RecvTask {
  id: string;
  fromMember: string;
  fromName: string;
  fromDevice: string;
  title: string;
  text: string;
  summary: string;
  repo: RepoOffer | null;
  lend: LendOffer | null;
  state: RecvState;
  atMs: number;
  updatedMs: number;
  /** A calm sentence about what the text mentions (a rule matched), or null. */
  risk: string | null;
  usage: 'theirs' | 'lent';
  lendError: string | null;
  repoState: RecvRepoState;
  repoGot: number;
  repoError: string | null;
  /** The new folder the repo was unpacked into. */
  unpacked: string | null;
}

export interface TasksView {
  sent: SentTask[];
  received: RecvTask[];
  handoverOn: boolean;
  lendOn: boolean;
  repoCapBytes: number;
}

export const EMPTY_TASKS: TasksView = { sent: [], received: [], handoverOn: false, lendOn: false, repoCapBytes: 2 * 1024 * 1024 };

export interface PassInput {
  toMember: string;
  title: string;
  text: string;
  summary: string;
  repo?: { path: string; history: RepoHistory; understood: boolean };
  lend?: { profileId: string; secs: number };
}

export interface AcceptInput {
  usage: 'theirs' | 'lent';
  wantRepo: boolean;
  understood: boolean;
}

export interface RepoCheck {
  ok: boolean;
  name: string;
  branch: string;
  /** A plain sentence when `ok` is false. */
  reason: string;
}

export interface TeamTasksApi {
  state: () => Promise<TasksView>;
  pass: (input: PassInput) => Promise<SentTask>;
  withdraw: (id: string) => Promise<void>;
  seen: (id: string) => Promise<void>;
  accept: (id: string, input: AcceptInput) => Promise<void>;
  decline: (id: string) => Promise<void>;
  started: (id: string) => Promise<void>;
  done: (id: string, note: string) => Promise<void>;
  unpack: (id: string, parent: string) => Promise<string>;
  handoverSet: (on: boolean) => Promise<void>;
  repoCheck: (path: string) => Promise<RepoCheck>;
  onChanged: (cb: () => void) => Promise<UnlistenFn>;
}

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const noop: UnlistenFn = () => {};

function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error(`Desktop shell required: ${command}`));
  return invoke<T>(command, args);
}

export const teamTasksApi: TeamTasksApi = {
  state: () => call('team_tasks_state'),
  pass: (input) => call('team_task_pass', { input }),
  withdraw: (id) => call('team_task_withdraw', { id }),
  seen: (id) => call('team_task_seen', { id }),
  accept: (id, input) => call('team_task_accept', { id, input }),
  decline: (id) => call('team_task_decline', { id }),
  started: (id) => call('team_task_started', { id }),
  done: (id, note) => call('team_task_done', { id, note }),
  unpack: (id, parent) => call('team_task_unpack', { id, parent }),
  handoverSet: (on) => call('team_tasks_handover_set', { on }),
  repoCheck: (path) => call('team_task_repo_check', { path }),
  onChanged: (cb) => (isTauri() ? listen('team://tasks-changed', () => cb()) : Promise.resolve(noop)),
};
