// Project guide (Labs `project_guide_enabled`): the pages an agent wrote about a project. This file knows the shapes the
// PC sends (camelCase, same as Rust), the calls, and the citation form `[[path:40-88]]` the pages use. The agent makes
// the pages; our code checks them. Nothing here starts a run by itself.
import { invoke } from '@tauri-apps/api/core';

export const GUIDE_LABS_KEY = 'project_guide_enabled' as const;

export type GuideSize = 'short' | 'normal' | 'deep';
export type GuidePhase = 'look' | 'outline' | 'pages' | 'diagram' | 'done' | 'stopped' | 'failed';

export interface GuideEstimate {
  token: string;
  size: GuideSize;
  projectSize: 'small' | 'medium' | 'large';
  filesRead: number;
  filesSkipped: number;
  skippedByReason: Record<string, number>;
  pagesLo: number;
  pagesHi: number;
  minutesLo: number;
  minutesHi: number;
  chatsLo: number;
  chatsHi: number;
  tokensMLo: number;
  tokensMHi: number;
  measured: boolean;
  tooSmall: boolean;
  truncated: boolean;
}

export interface GuideProgress {
  phase: GuidePhase;
  pagesTotal: number;
  pagesDone: number;
  current: string[];
  calls: number;
  tokens: number;
  error: string | null;
  notes: string[];
  startedMs: number;
  finishedMs: number | null;
}

export interface GuideRun extends GuideProgress {
  kind: 'make' | 'refresh';
}

export interface GuidePageSummary {
  id: string;
  title: string;
  purpose: string;
  stale: boolean;
  needsReview: boolean;
}

export interface GuideStructure {
  commit: string | null;
  writtenAtMs: number;
  agent: string;
  model: string | null;
  complete: boolean;
  pages: GuidePageSummary[];
  diagram: boolean;
  diagramStale: boolean;
}

export interface GuideState {
  enabled: boolean;
  hasGuide: boolean;
  structure: GuideStructure | null;
  run: GuideRun | null;
  last: GuideRun | null;
  dryRun: boolean;
}

export interface GuidePage {
  id: string;
  title: string;
  markdown: string;
  stale: boolean;
  changed: string[];
  needsReview: boolean;
}

export interface GuideBox {
  label: string;
  path: string | null;
  page: string | null;
}

export interface GuideDiagram {
  mermaid: string;
  boxes: GuideBox[];
  stale: boolean;
}

/** The agent name that makes the PC use its built-in stand-in (development builds only). */
export const DRY_RUN_AGENT = 'dry-run';

export interface GuideStartArgs {
  token: string;
  mode: 'make' | 'refresh';
  size: GuideSize;
  /** The agent that writes; `dry-run` for the stand-in. Absent: the PC picks the first installed agent. */
  agent?: string;
}

/** The calls the Guide tab needs (a test double can stand in). Every call names the pane; the project is the pane's own. */
export interface GuideApi {
  state(paneId: string): Promise<GuideState>;
  estimate(paneId: string, size?: GuideSize): Promise<GuideEstimate>;
  start(paneId: string, args: GuideStartArgs): Promise<void>;
  stop(paneId: string): Promise<boolean>;
  readPage(paneId: string, id: string): Promise<GuidePage>;
  readDiagram(paneId: string): Promise<GuideDiagram>;
  remove(paneId: string): Promise<boolean>;
}

export const guideApi: GuideApi = {
  state: (paneId) => invoke<GuideState>('guide_state', { paneId }),
  estimate: (paneId, size) => invoke<GuideEstimate>('guide_estimate', { paneId, size }),
  start: (paneId, a) => invoke<void>('guide_start', { paneId, token: a.token, mode: a.mode, size: a.size, agent: a.agent }),
  stop: (paneId) => invoke<boolean>('guide_stop', { paneId }),
  readPage: (paneId, id) => invoke<GuidePage>('guide_read_page', { paneId, id }),
  readDiagram: (paneId) => invoke<GuideDiagram>('guide_read_diagram', { paneId }),
  remove: (paneId) => invoke<boolean>('guide_delete', { paneId }),
};

/** A run is going now. */
export const isRunning = (run: GuideRun | null | undefined): boolean => !!run && run.phase !== 'done' && run.phase !== 'stopped' && run.phase !== 'failed';

/** How many pages are out of date (plus the diagram, which counts as one). */
export function staleCount(s: GuideStructure | null): number {
  if (!s) return 0;
  return s.pages.filter((p) => p.stale).length + (s.diagramStale ? 1 : 0);
}

// ---- citations -----------------------------------------------------------------------------------------------------

export type CitationPart = { kind: 'text'; text: string } | { kind: 'cite'; raw: string; path: string; start: number | null; end: number | null };

const CITATION = /\[\[([^\[\]\r\n]{1,300})\]\]/g;
const RANGE = /^(\d{1,7})(?:-(\d{1,7}))?$/;

/** A path the chip may open: relative, inside the project, no drive, no `..`. Anything else is not a chip. */
export function isSafeRelPath(path: string): boolean {
  const p = path.trim();
  if (!p || p.includes('\0')) return false;
  if (/^([/\\~]|[A-Za-z]:)/.test(p)) return false;
  return !p.replace(/\\/g, '/').split('/').includes('..');
}

/** Splits a page into text and citation chips. A `[[...]]` with an unsafe path stays plain text. */
export function splitCitations(markdown: string): CitationPart[] {
  const parts: CitationPart[] = [];
  let last = 0;
  const push = (text: string) => {
    if (!text) return;
    const prev = parts[parts.length - 1];
    if (prev && prev.kind === 'text') prev.text += text;
    else parts.push({ kind: 'text', text });
  };
  for (const m of markdown.matchAll(CITATION)) {
    const inner = m[1].trim();
    let path = inner;
    let start: number | null = null;
    let end: number | null = null;
    const cut = inner.lastIndexOf(':');
    if (cut > 0) {
      const r = RANGE.exec(inner.slice(cut + 1).trim());
      if (r) {
        path = inner.slice(0, cut).trim();
        start = Number(r[1]);
        end = r[2] ? Number(r[2]) : start;
      }
    }
    push(markdown.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    if (isSafeRelPath(path)) parts.push({ kind: 'cite', raw: m[0], path: path.replace(/\\/g, '/'), start, end });
    else push(m[0]);
  }
  push(markdown.slice(last));
  return parts;
}

/** `src/sync/queue.ts 40-88` (or the path alone). */
export function citationLabel(c: { path: string; start: number | null; end: number | null }): string {
  if (c.start === null) return c.path;
  return c.end !== null && c.end !== c.start ? `${c.path} ${c.start}-${c.end}` : `${c.path} ${c.start}`;
}

export interface Source {
  n: number;
  path: string;
  start: number | null;
  end: number | null;
}

/** The page with each citation replaced by a small number, and the numbered list of what was cited (same source = same number). */
export function numberCitations(markdown: string): { text: string; sources: Source[] } {
  const sources: Source[] = [];
  let text = '';
  for (const part of splitCitations(markdown)) {
    if (part.kind === 'text') {
      text += part.text;
      continue;
    }
    const key = citationLabel(part);
    let s = sources.find((x) => citationLabel(x) === key);
    if (!s) {
      s = { n: sources.length + 1, path: part.path, start: part.start, end: part.end };
      sources.push(s);
    }
    text += `〔${s.n}〕`;
  }
  return { text, sources };
}

/** "3 days ago" in the person's language, from a time in ms. */
export function ageWords(thenMs: number, nowMs: number, t: (key: never, vars?: Record<string, string | number>) => string): string {
  const tt = t as unknown as (key: string, vars?: Record<string, string | number>) => string;
  const mins = Math.max(0, Math.round((nowMs - thenMs) / 60000));
  if (mins < 1) return tt('guide.ageNow');
  if (mins < 60) return tt('guide.ageMinutes', { n: mins });
  const hours = Math.round(mins / 60);
  if (hours < 48) return tt('guide.ageHours', { n: hours });
  return tt('guide.ageDays', { n: Math.round(hours / 24) });
}
