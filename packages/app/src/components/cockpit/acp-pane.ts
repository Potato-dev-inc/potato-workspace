// What the pane of a chat session over ACP says about itself: its status in the person's words, and the compact
// "what this run produced" line (files changed, the agent's own potato-result block). Pure, so it is tested alone.
import type { TurnSummary } from '../../lib/cockpit-api';

/** The status words of a chat pane: working / waiting for you / done. */
export function acpStatusWords(status: string): string {
  switch (status) {
    case 'running':
      return 'Working';
    case 'waiting_input':
      return 'Waiting for you';
    case 'idle':
      return 'Done';
    case 'error':
      return 'Error';
    default:
      return 'Stopped';
  }
}

export interface AcpResult {
  /** "3 files +14 −3" from the last turn; null when the turn counted no files. */
  files: string | null;
  /** The paths behind `files`, for its tooltip. */
  paths: string[];
  /** The agent's own one-line summary (receipt structured_result.summary). */
  summary: string | null;
  checks: string[];
  questions: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);

/** The strip's content from the last turn and the run's receipt; null when there is nothing to show yet. */
export function acpResult(turn: TurnSummary | undefined, receipt: unknown): AcpResult | null {
  const sr = (receipt as { structured_result?: unknown } | null | undefined)?.structured_result as
    | { summary?: unknown; files_changed?: unknown; checks_run?: unknown; open_questions?: unknown }
    | null
    | undefined;
  const summary = typeof sr?.summary === 'string' && sr.summary.trim() ? sr.summary.trim() : null;
  const turnFiles = turn?.files && turn.files.count > 0 ? turn.files : null;
  const reported = strings(sr?.files_changed);
  const paths = turnFiles?.paths.length ? turnFiles.paths : reported;
  const files = turnFiles
    ? `${turnFiles.count} ${turnFiles.count === 1 ? 'file' : 'files'} +${turnFiles.added} −${turnFiles.deleted}`
    : reported.length > 0
      ? `${reported.length} ${reported.length === 1 ? 'file' : 'files'}`
      : null;
  const checks = strings(sr?.checks_run);
  const questions = strings(sr?.open_questions);
  if (!files && !summary && checks.length === 0 && questions.length === 0) return null;
  return { files, paths, summary, checks, questions };
}
