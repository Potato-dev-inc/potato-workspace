// The Settings shell's words in the person's language, looked up at display time. The page, group and row
// definitions (arrange.tsx, catalog.ts, model.ts) keep their English text as data; this layer finds a translation by
// id and falls back to that English when there is none. Search sees both: the translated words and the English ones.
import { getLanguage, t, type MessageKey } from '../../i18n';
import type { SwitchStyle, WindowLayoutChoice } from '../../lib/mode-switch/model';
import { searchAll, searchNames, type SearchResult } from './search';
import type { RowDef, SectionDef } from './model';

/** The translation of `key`, or `english` when the key has no text (the layer answers with the key itself then). */
export function translateOr(key: string, english: string): string {
  const text = t(key as MessageKey);
  return text === key ? english : text;
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const pageTitle = (page: { id: string; title: string }): string => translateOr(`settings.page.${page.id}.title`, page.title);
export const pageBlurb = (page: { id: string; blurb: string }): string => translateOr(`settings.page.${page.id}.blurb`, page.blurb);
/** A group heading, by its English name. */
export const groupTitle = (group: string): string => translateOr(`settings.group.${slug(group)}`, group);
export const rowLabel = (row: { id: string; label: string }): string => translateOr(`settings.row.${row.id}.label`, row.label);
export const rowHint = (row: { id: string; hint?: string }): string | undefined => (row.hint ? translateOr(`settings.row.${row.id}.hint`, row.hint) : row.hint);

export const styleLabel = (style: SwitchStyle): string => t(`lookFeel.style.${style}`);
export const windowLayoutLabel = (layout: WindowLayoutChoice): string => t(layout === 'cascade' ? 'lookFeel.layout.cascade' : 'lookFeel.layout.sideBySide');

/** Words a translated row must still be found by: the English ones. */
function withEnglishKeywords(row: RowDef, group: string | undefined): string {
  return [row.keywords, row.label, group].filter(Boolean).join(' ');
}

/**
 * The pages with their page titles, blurbs and row labels and hints in the current language (English keeps the very
 * same objects). A row's `group` stays the English name, because the page code matches on it; the heading is drawn
 * through `groupTitle`. The English label and group are added to each row's keywords so English words still find it.
 */
export function localizeSections(sections: SectionDef[]): SectionDef[] {
  if (getLanguage() === 'en') return sections;
  return sections.map((section) => ({
    ...section,
    title: pageTitle(section),
    blurb: pageBlurb(section),
    rows: section.rows.map((row) => {
      const label = rowLabel(row);
      const hint = rowHint(row);
      const group = row.group ? groupTitle(row.group) : undefined;
      if (label === row.label && hint === row.hint && group === row.group) return row;
      return { ...row, label, hint, keywords: `${withEnglishKeywords(row, row.group)} ${group ?? ''}` };
    }),
  }));
}

/**
 * Search over the localized pages. "Go to page" hits also include pages and groups that the English words name, so
 * "helpers" finds the Helpers page while the app speaks Chinese.
 */
export function searchLocalized(english: SectionDef[], localized: SectionDef[], query: string): SearchResult {
  const result = searchAll(localized, query);
  if (english === localized) return result;
  const extra = searchNames(english, query)
    .filter((n) => !result.names.some((m) => m.page.id === n.page.id && m.group === n.group))
    .map((n) => ({ ...n, page: localized.find((s) => s.id === n.page.id) ?? n.page }));
  return { ...result, names: [...result.names, ...extra] };
}
