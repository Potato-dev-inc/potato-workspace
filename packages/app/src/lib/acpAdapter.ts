// The reviewed-adapter option of "Add chat": which key groups still need a saved key, the version note and the plain lines.
// Names, labels and yes/no only. A key value never reaches this file.
import type { AdapterKeyRow, AdapterKeyStatus, AdapterSettingRow } from './acpChat';

/** The key groups with no saved key yet. Each group needs at least one of its keys (one is enough). */
export function unmetGroups(groups: readonly (readonly string[])[] | undefined, statuses: readonly AdapterKeyStatus[]): string[][] {
  return (groups ?? []).filter((g) => !g.some((env) => statuses.some((s) => s.env === env && s.set))).map((g) => [...g]);
}

/** The labels of a group's keys as a short phrase: "OpenRouter or OpenAI". Unknown names show as the variable name. */
export function groupPhrase(group: readonly string[], keys: readonly AdapterKeyRow[]): string {
  const names = group.map((env) => keys.find((k) => k.env === env)?.label ?? env);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/** The line that says which key still has to be saved, or null when every group has one. */
export function missingKeysLine(groups: readonly (readonly string[])[] | undefined, statuses: readonly AdapterKeyStatus[], keys: readonly AdapterKeyRow[]): string | null {
  const unmet = unmetGroups(groups, statuses);
  if (unmet.length === 0) return null;
  return `Save a key first: ${unmet.map((g) => groupPhrase(g, keys)).join('; ')}. One of each is enough.`;
}

/** The first line on the confirm screen. */
export const testedLine = (tested: string): string => `Reviewed adapter, tested on version ${tested}.`;

/** The note when this PC has another version than the adapter was tested on; null when they match or it is unknown. */
export function versionNote(tested: string, installed: string | null | undefined): string | null {
  if (!installed || installed === tested) return null;
  return `This computer has version ${installed}. The adapter was tested on ${tested}, so check the chat before you rely on it.`;
}

/** Every setting at its public default (the starting values of the settings inputs). */
export function settingDefaults(settings: readonly AdapterSettingRow[] | undefined): Record<string, string> {
  return Object.fromEntries((settings ?? []).map((s) => [s.env, s.default]));
}

/** The value a setting starts at: the first choice whose key is saved (a choice with no key always counts), else the default. */
export function preferredValue(setting: AdapterSettingRow, statuses: readonly AdapterKeyStatus[]): string {
  const pick = (setting.options ?? []).find((o) => !o.needs_key || statuses.some((s) => s.env === o.needs_key && s.set));
  return pick ? pick.value : setting.default;
}
