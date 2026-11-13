// Settings window model: the eight pages, the row contract every section implements, and search.
//
// A page is a list of rows (`RowDef`). The panel renders them grouped, filters them when you search
// (label + hint + keywords + synonyms), and hands every row a `SettingsEnv`: the fresh settings, a partial-patch
// `patch()` that saves one control, and a few helpers. Nothing in a row ever writes the whole settings
// object back.
import type { ReactNode } from 'react';
import type { Settings } from '@potato-workspace/shared';
import type { SettingsPatch } from '../../lib/settings';
import { queryUnits, wordsOf } from './synonyms';

/** The pages a person sees, in nav order. Rows are defined in the older section files (`BASE_SECTION_IDS`) and placed by `arrange.tsx`. */
export const SECTION_IDS = ['overview', 'agents', 'helpers', 'look', 'connect', 'keys', 'shortcuts', 'advanced'] as const;
export type SectionId = (typeof SECTION_IDS)[number];

/** The section files that define the rows. Old links may still name them (see `LEGACY_TABS`). */
export const BASE_SECTION_IDS = ['general', 'agents', 'models', 'keys', 'bridge', 'phone', 'team', 'lend', 'shortcuts'] as const;
export type BaseSectionId = (typeof BASE_SECTION_IDS)[number];

export type SettingsPageId = SectionId;

export interface ConfirmOptions {
  title: string;
  body: string;
  /** Label of the confirm button, for example "Uninstall". */
  confirmLabel: string;
}

/** What the panel gives a row. Rows never touch storage themselves. */
export interface SettingsEnv {
  /** The current saved settings (reloaded when they change anywhere). */
  settings: Settings;
  /**
   * Save only the keys in `patch` (merged into the file on the Rust side) and flash the row's
   * "Saved" tick. Rejects when the write fails; the panel shows the error on the row.
   */
  patch: (patch: SettingsPatch) => Promise<void>;
  /** Flash the "Saved" tick for a control that saved through its own command. */
  markSaved: () => void;
  /** Show the row's error line (and clear it with `null`). */
  setError: (message: string | null) => void;
  /** Ask in-app before something destructive. Resolves true when the person confirms. */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** Jump to another row (even one in another section): a "Now in General › Labs" link. Absent in tests. */
  openRow?: (rowId: string) => void;
  /** Opens the Agent Store in the cockpit. Absent in the separate Settings window (the Store lives in the cockpit). */
  openStore?: () => void;
  projectPath: string | null;
  onProjectPathChange?: (path: string) => Promise<void>;
  /** Discovered local bridge URL, or null before discovery. */
  bridgeUrl: string | null;
}

/**
 * How much a person needs a row. `basic` rows show at first; `advanced` rows sit under the section's closed
 * "Advanced" group; `developer` rows show only while "Show developer settings" is on. Search finds every level.
 */
export type RowLevel = 'basic' | 'advanced' | 'developer';

export interface RowDef {
  /** Unique across all sections. Used for the "Saved" tick, tests and screenshots. */
  id: string;
  /** Default `advanced` (see `rowLevel`). Set in catalog.ts, where the basic rows are named. */
  level?: RowLevel;
  /** What the row is called. Searched. */
  label: string;
  /** The one-line explanation under the label. Searched. */
  hint?: string;
  /** Extra words that should find this row (labels of controls inside a composite row). */
  keywords?: string;
  /** Heading of the group this row belongs to. Consecutive rows with the same group share a list. */
  group?: string;
  /** Destructive: shown in the section's own last group, and always behind a confirm sheet. */
  danger?: boolean;
  /**
   * An early (off-by-default) feature: its short name and one plain line about it. `arrangeSections` collects
   * every row that has one into General > Labs, wherever the row is defined, and lists it there.
   */
  labs?: { name: string; about: string };
  /** A link left where a row used to be. Never searched (the real row is), and has no setting of its own. */
  pointer?: boolean;
  /** An early feature's own row: shown (and searched) only while this Labs flag is on. Hidden otherwise, as if it did not exist. */
  labsFlag?: 'acp_chat_enabled' | 'model_bridge_enabled' | 'lend_enabled';
  /** The saved keys this row owns. Rows without it are actions or panels. (Used by the Changed dot, Reset and Undo.) */
  keys?: (keyof Settings)[];
  /** A small frame drawn at the right of, or under, the control. */
  preview?: (env: SettingsEnv) => ReactNode;
  /** The value in words, for the Undo toast ("Theme: Light"). */
  valueText?: (settings: Settings) => string;
  render: (env: SettingsEnv) => ReactNode;
}

/** A section as its file defines it (the older nine). */
export interface BaseSectionDef {
  id: BaseSectionId;
  title: string;
  blurb: string;
  rows: RowDef[];
}

export interface SectionDef {
  id: SectionId;
  title: string;
  /** One quiet line under the page title. */
  blurb: string;
  rows: RowDef[];
  /** The Advanced page: these groups are closed disclosure headers (no "Advanced" fold on that page). */
  closedGroups?: string[];
}

/** The level of a row; a row without one is advanced. */
export function rowLevel(row: RowDef): RowLevel {
  return row.level ?? 'advanced';
}

/**
 * A section's rows split by level. `developer` is empty unless `showDeveloper` is on, so a hidden row is not
 * drawn at all (search still finds it: `searchSections` takes every row).
 */
export function splitByLevel(rows: RowDef[], showDeveloper: boolean): { basic: RowDef[]; advanced: RowDef[]; developer: RowDef[] } {
  return {
    basic: rows.filter((r) => rowLevel(r) === 'basic'),
    advanced: rows.filter((r) => rowLevel(r) === 'advanced'),
    developer: showDeveloper ? rows.filter((r) => rowLevel(r) === 'developer') : [],
  };
}

/**
 * The sections a person sees now: rows of an early feature appear only while their switch is on.
 */
export function visibleSections(sections: SectionDef[], settings: { acp_chat_enabled?: boolean; model_bridge_enabled?: boolean; lend_enabled?: boolean } | null): SectionDef[] {
  return sections
    .map((s) => (s.rows.some((r) => r.labsFlag) ? { ...s, rows: s.rows.filter((r) => !r.labsFlag || settings?.[r.labsFlag] === true) } : s))
    .filter((s) => s.rows.length > 0);
}

export interface RowGroup {
  /** Group heading, if any. */
  head?: string;
  danger: boolean;
  rows: RowDef[];
}

/** Rows of a section as lists: consecutive same-group rows together, destructive rows last in their own list. */
export function groupRows(rows: RowDef[]): RowGroup[] {
  const groups: RowGroup[] = [];
  for (const row of rows.filter((r) => !r.danger)) {
    const last = groups[groups.length - 1];
    if (last && !last.danger && last.head === row.group) last.rows.push(row);
    else groups.push({ head: row.group, danger: false, rows: [row] });
  }
  const danger = rows.filter((r) => r.danger);
  if (danger.length > 0) groups.push({ head: undefined, danger: true, rows: danger });
  return groups;
}

const words = wordsOf;

/** What a synonym hit scores: the same as a keyword hit. */
export const SYNONYM_SCORE = 2;

/**
 * How well `row` answers one typed word, or 0 for no match. The label and the curated keywords match from the
 * start of a word, so "key" finds "API key" and "keychain". The hint only matches a whole word, so "key" no
 * longer finds "keyboard" in an unrelated hint.
 */
function wordScore(row: RowDef, typed: string): number {
  // "keys" also finds "key": try the word without a plural s.
  const candidates = typed.length > 3 && typed.endsWith('s') ? [typed, typed.slice(0, -1)] : [typed];
  return Math.max(...candidates.map((word) => wordScoreExact(row, word)));
}

function wordScoreExact(row: RowDef, word: string): number {
  const label = words(row.label);
  if (label.includes(word)) return 4;
  if (label.some((w) => w.startsWith(word))) return 3;
  const keys = words(row.keywords ?? '');
  if (keys.some((w) => w.startsWith(word))) return 2;
  if (words(row.hint ?? '').includes(word)) return 1;
  return 0;
}

/** Every word in the query must match the row's label, keywords or hint. Pointers never match. */
export function rowMatches(row: RowDef, query: string, extra = ''): boolean {
  return rowScore(row, query, extra) > 0;
}

/** Whether one synonym (a list of words) is in the row's label, or its keywords, or `extra` (group and page names). */
function altMatches(row: RowDef, alt: string[], extra: string): boolean {
  const label = words(row.label);
  const keys = words(`${row.keywords ?? ''} ${extra}`);
  return alt.every((word) => {
    const stem = word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
    return label.some((w) => w.startsWith(stem)) || keys.some((w) => w.startsWith(stem));
  });
}

function altInLabel(row: RowDef, alt: string[]): boolean {
  const label = words(row.label);
  return alt.every((word) => {
    const stem = word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
    return label.some((w) => w.startsWith(stem));
  });
}

/**
 * The sum of the word scores (0 when any typed word or phrase finds nothing). Label matches outrank hint
 * matches. A typed word is widened to its synonyms (synonyms.ts); a synonym finds the label, keywords and
 * `extra` (the group and page names) only, and scores as a keyword. Rows marked `danger` answer the delete words.
 */
export function rowScore(row: RowDef, query: string, extra = ''): number {
  const units = queryUnits(query);
  if (units.length === 0) return 1;
  if (row.pointer) return 0;
  let total = 0;
  for (const unit of units) {
    const scores = unit.words.map((word) => wordScore(row, word));
    let best = scores.every((s) => s > 0) ? scores.reduce((a, b) => a + b, 0) : 0;
    if (best < SYNONYM_SCORE) {
      // A synonym that finds the row's own label ranks above one that only finds its keywords or its group's name.
      if (unit.alts.some((alt) => altMatches(row, alt, ''))) best = Math.max(best, SYNONYM_SCORE + (unit.alts.some((alt) => altInLabel(row, alt)) ? 0.5 : 0));
      else if (unit.alts.some((alt) => altMatches(row, alt, extra)) || (unit.danger && row.danger)) best = Math.max(best, SYNONYM_SCORE);
    }
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

export interface SearchHit {
  section: SectionDef;
  rows: RowDef[];
}

/**
 * Rows that match `query`, grouped under their section in nav order. Empty sections are left out. Inside a
 * section the best-matching group comes first, and inside a group the best-matching row, so a label match
 * is never buried under hint matches. Rows of one group stay together (the panel shows the group's title).
 */
export function searchSections(sections: SectionDef[], query: string): SearchHit[] {
  if (!query.trim()) return [];
  return sections
    .map((section) => {
      const scored = section.rows
        .map((row, index) => ({ row, index, score: rowScore(row, query, `${section.title} ${row.group ?? ''}`) }))
        .filter((r) => r.score > 0);
      const best = new Map<string | undefined, number>();
      const first = new Map<string | undefined, number>();
      for (const r of scored) {
        best.set(r.row.group, Math.max(best.get(r.row.group) ?? 0, r.score));
        if (!first.has(r.row.group)) first.set(r.row.group, r.index);
      }
      scored.sort(
        (a, b) =>
          (best.get(b.row.group) ?? 0) - (best.get(a.row.group) ?? 0) ||
          (first.get(a.row.group) ?? 0) - (first.get(b.row.group) ?? 0) ||
          b.score - a.score ||
          a.index - b.index,
      );
      return { section, rows: scored.map((r) => r.row), top: Math.max(0, ...scored.map((r) => r.score)) };
    })
    .filter((hit) => hit.rows.length > 0)
    // The page with the best hit first; pages with equal scores keep the nav order (the sort is stable).
    .sort((a, b) => b.top - a.top)
    .map(({ section, rows }) => ({ section, rows }));
}

/** The section a row lives in, by its id (ids are unique across all sections). */
export function findRowSection(sections: SectionDef[], rowId: string): SectionDef | undefined {
  return sections.find((s) => s.rows.some((r) => r.id === rowId));
}
