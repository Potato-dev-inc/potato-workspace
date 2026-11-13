// Plain-words helpers for the ship features: no React, no IPC. Tested in ship-model.test.ts.
import { t } from '../i18n';
import type { ChecksReport, GitState, PrPrepared, RecentProject, SetupReport } from './ship-api';

/** `2 GitHub checks failed: test (ubuntu), lint` and friends. */
export function checksSentence(report: ChecksReport | undefined | null): string {
  if (!report) return t('state.ship.checking');
  const failed = report.items.filter((i) => i.state === 'fail');
  const pending = report.items.filter((i) => i.state === 'pending');
  switch (report.state) {
    case 'failing':
      return t('state.ship.failed', { count: failed.length, names: failed.map((i) => i.name).join(', ') });
    case 'pending':
      return t('state.ship.pending', { count: pending.length });
    case 'passing':
      return t('state.ship.passed', { count: report.items.length });
    default:
      return t('state.ship.none');
  }
}

/** Why Create PR cannot run yet, in words a non-expert understands; `null` when it can. */
export function cannotCreate(p: PrPrepared): { text: string; command?: string; heading?: string; byHand?: boolean } | null {
  if (p.gh === 'missing') {
    return {
      text: t('state.ship.ghMissing'),
      byHand: true,
    };
  }
  if (p.gh === 'signed_out') {
    return { text: t('state.ship.ghSignedOut'), command: 'gh auth login' };
  }
  if (!p.has_remote) {
    // Short on purpose: say why, then give the exact commands for whoever adds a remote later.
    return {
      text: t('state.ship.noRemote'),
      heading: t('state.ship.noRemoteHeading'),
      byHand: true,
    };
  }
  if (!p.on_github) {
    return { text: t('state.ship.notOnGithub') };
  }
  return null;
}

/**
 * The commands to run by hand when `gh` is missing: push the branch, then open the pull request
 * from the page GitHub prints (or with `gh` once it is installed).
 */
export function copyCommands(branch: string, base: string, title: string): string {
  const safe = title.replace(/"/g, "'");
  return [`git push --set-upstream origin ${branch}`, `gh pr create --draft --base ${base} --head ${branch} --title "${safe}"`].join('\n');
}

/** One line about how the copy was set up, for the receipt and the Changes tab. */
export function setupLine(setup: SetupReport | undefined | null): string | null {
  if (!setup) return null;
  const parts: string[] = [];
  for (const s of setup.steps) {
    parts.push(s.ok ? t('state.ship.stepRan', { command: s.command }) : s.timed_out ? t('state.ship.stepTimedOut', { command: s.command }) : t('state.ship.stepError', { command: s.command }));
  }
  if (setup.copied.length > 0) parts.push(t('state.ship.copied', { files: setup.copied.join(', ') }));
  if (parts.length === 0) return null;
  const text = parts.join(t('state.ship.join'));
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return setup.status === 'failed' ? t('state.ship.setupFailed', { text }) : t('state.ship.sentence', { text: sentence });
}

/** The sentence for a folder in the recents list. */
export function stateHint(state: GitState): string {
  switch (state) {
    case 'missing':
      return t('state.ship.missing');
    case 'folder':
      return t('state.ship.folder');
    case 'no_commits':
      return t('state.ship.noCommits');
    default:
      return '';
  }
}

/** Separate copies need a Git repository with a first commit. */
export const supportsCopies = (state: GitState | undefined): boolean => state === undefined || state === 'repo';

/** The project folder a pane works in: a separate copy's folder maps back to its origin project. */
export function projectOfCwd(cwd: string | undefined | null): { path: string; name: string } | null {
  if (!cwd) return null;
  const slashed = cwd.replace(/\\/g, '/');
  const at = slashed.indexOf('/.potato-workspace/worktrees/');
  const path = at > 0 ? cwd.slice(0, at) : cwd;
  const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
  return { path, name };
}

const KEY = 'pm.separate-copy';

/**
 * What this person chose for a project last time: `true`, `false`, or `undefined` when they never chose.
 * (A per-viewer convenience: browser storage is fine.)
 */
export function readStoredCopyPreference(project: string | null): boolean | undefined {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, boolean>;
    const value = all[project ?? ''];
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Separate copy is remembered per project; no remembered choice reads as off. */
export function readCopyPreference(project: string | null): boolean {
  return readStoredCopyPreference(project) === true;
}

/**
 * Whether the "Separate copy" switch starts on. It starts OFF: the folder the person selected is the
 * folder the agent works in. (Until 2026-10-18 it started on for a Git project; that was reversed.)
 * A choice the person made for this project, in either direction, always wins; only a clicked switch is
 * ever stored, so "never chose" stays `undefined` and reads as off.
 */
export function copyDefault(remembered: boolean | undefined): boolean {
  return remembered ?? false;
}

/** True when `path` is the folder of a separate copy (`<project>/.potato-workspace/worktrees/<id>`). */
const isCopyPath = (path: string): boolean => path.replace(/\\/g, '/').indexOf('/.potato-workspace/worktrees/') > 0;

/**
 * The recent-projects list as the person should see it: a separate copy's folder is mapped back to the
 * project it came from, and each real folder appears once (first, i.e. most recent, wins). The backend
 * already does this; this keeps a copy off the screen even if one ever slips through.
 */
export function realRecents(list: RecentProject[]): RecentProject[] {
  const seen = new Set<string>();
  const out: RecentProject[] = [];
  for (const item of list) {
    const real = isCopyPath(item.path) ? projectOfCwd(item.path) : null;
    const path = real ? real.path : item.path;
    const key = path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(real ? { ...item, path, name: real.name } : item);
  }
  return out;
}

/**
 * The folder "+" starts in when nothing else names one: the newest real folder the person used. A folder
 * that only ever had runs (`last_used_ms` 0) or no longer exists does not count.
 */
export function lastRealFolder(list: RecentProject[]): { path: string; name: string; state: GitState } | null {
  const found = realRecents(list).find((item) => item.last_used_ms > 0 && item.state !== 'missing');
  return found ? { path: found.path, name: found.name, state: found.state } : null;
}

export function writeCopyPreference(project: string | null, on: boolean): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, boolean>;
    all[project ?? ''] = on;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage can be blocked: the switch just is not remembered */
  }
}
