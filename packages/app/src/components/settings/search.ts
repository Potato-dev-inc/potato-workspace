// Settings search over the arranged pages: rows (label, keywords, hint, synonyms), and the page and group names
// ("helpers" lists the Helpers page first as a "Go to page" hit). Pure; the panel draws the result.
import { rowLevel, searchSections, type RowDef, type SearchHit, type SectionDef } from './model';
import { wordsOf } from './synonyms';

/** Rows that are a live panel (a list, a check): in search they show as one line with a "Go to row" button, never the panel itself. */
export const PANEL_ROWS: ReadonlySet<string> = new Set(['setup-check', 'agent-list']);

/** Hits shown before "Show all N". */
export const MAX_HITS = 30;

/** Score of a page or group name hit. */
export const NAME_SCORE = 3;

export interface NameHit {
  page: SectionDef;
  /** Set when a group of the page matched rather than the page itself. */
  group?: string;
}

export interface SearchResult {
  /** "Go to page" hits: pages first, then groups, in nav order. */
  names: NameHit[];
  /** Row hits grouped under their page, in nav order. */
  hits: SearchHit[];
  /** Number of row hits. */
  total: number;
}

function startsAll(typed: string[], title: string): boolean {
  const own = wordsOf(title);
  return typed.length > 0 && typed.every((word) => own.some((w) => w.startsWith(word)));
}

/** Pages and groups whose name every typed word starts. A group counts only when it has a row on the page. */
export function searchNames(sections: SectionDef[], query: string): NameHit[] {
  const typed = wordsOf(query).map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
  if (typed.length === 0) return [];
  const pages: NameHit[] = [];
  const groups: NameHit[] = [];
  for (const page of sections) {
    if (startsAll(typed, page.title)) pages.push({ page });
    const seen = new Set<string>();
    for (const row of page.rows) {
      const group = row.group;
      if (!group || seen.has(group) || row.danger) continue;
      seen.add(group);
      if (group !== page.title && startsAll(typed, group)) groups.push({ page, group });
    }
  }
  // One "Go to page" per page: a group of a page that is already listed adds nothing.
  const listed = new Set(pages.map((p) => p.page.id));
  return [...pages, ...groups.filter((g) => !listed.has(g.page.id))];
}

/** Everything a typed query finds. Every level is searched; rows of a switched-off Labs flag must already be left out of `sections`. */
export function searchAll(sections: SectionDef[], query: string): SearchResult {
  if (!query.trim()) return { names: [], hits: [], total: 0 };
  const hits = searchSections(sections, query);
  return { names: searchNames(sections, query), hits, total: hits.reduce((n, h) => n + h.rows.length, 0) };
}

/** The first `limit` row hits, keeping the page and group order. */
export function limitHits(hits: SearchHit[], limit: number): SearchHit[] {
  let left = limit;
  const out: SearchHit[] = [];
  for (const hit of hits) {
    if (left <= 0) break;
    const rows = hit.rows.slice(0, left);
    left -= rows.length;
    out.push({ section: hit.section, rows });
  }
  return out;
}

/** "Page > Group" for a row on a page. */
export function rowPath(page: SectionDef, row: RowDef): string {
  return row.group ? `${page.title} > ${row.group}` : page.title;
}

/** The small grey tag a hit carries: only Advanced and Developer rows have one. */
export function levelTag(row: RowDef): 'Advanced' | 'Developer' | null {
  const level = rowLevel(row);
  return level === 'developer' ? 'Developer' : level === 'advanced' ? 'Advanced' : null;
}
