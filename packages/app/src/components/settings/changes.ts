// What a person changed: per row, which saved keys differ from the default, how to put them back, and how to say
// a value in words (for the Undo toast). Pure functions; the panel and the tests share them.
//
// A key "has a default" when it is in DEFAULT_SETTINGS (lib/settings-defaults.ts) or in EXTRA_DEFAULTS (a few switches
// the row itself reads with `?? true`). A key that is absent (or null) is at its default. A key with no default means
// "not set": false and an empty text count as not set too, so a switch turned on and off again is not reported as changed.
import type { Settings } from '@potato-workspace/shared';
import { DEFAULT_HANDOFF_MODE } from '../../lib/handoff';
import { DEFAULT_SETTINGS } from '../../lib/settings-defaults';
import type { SettingsPatch } from '../../lib/settings';
import type { RowDef, SectionDef } from './model';

/** Defaults the rows apply themselves (`?? true`) that DEFAULT_SETTINGS does not list. */
const EXTRA_DEFAULTS: Partial<Settings> = {
  pane_mcp_enabled: true,
  handoff_mode: DEFAULT_HANDOFF_MODE,
};

export const SETTING_DEFAULTS: Partial<Settings> = { ...DEFAULT_SETTINGS, ...EXTRA_DEFAULTS };

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function isNotSet(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === '') return true;
  return typeof value === 'object' && Object.keys(value as object).length === 0;
}

/** Whether one saved key is at its default. */
export function isDefault(key: keyof Settings, settings: Settings): boolean {
  const value = settings[key];
  // Nothing saved is the default, whatever the row shows for it.
  if (value === undefined || value === null) return true;
  const fallback = SETTING_DEFAULTS[key];
  return fallback === undefined ? isNotSet(value) : deepEqual(value, fallback);
}

/** The keys of `row` that differ from the default. A row without `keys` never does. */
export function changedKeys(row: RowDef, settings: Settings): (keyof Settings)[] {
  if (row.danger) return [];
  return (row.keys ?? []).filter((key) => !isDefault(key, settings));
}

export function isChanged(row: RowDef, settings: Settings): boolean {
  return changedKeys(row, settings).length > 0;
}

/** One patch that puts every key of the row back to its default (or removes it). */
export function resetPatch(row: RowDef): SettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const key of row.keys ?? []) patch[key] = SETTING_DEFAULTS[key] ?? null;
  return patch as SettingsPatch;
}

/** The settings after a patch (null removes a key), for saying the new value in words. */
export function applyPatch(settings: Settings, patch: SettingsPatch): Settings {
  const next: Record<string, unknown> = { ...settings };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as unknown as Settings;
}

/** The patch that puts the keys of `patch` back to what `before` held. */
export function undoPatch(before: Settings, patch: SettingsPatch): SettingsPatch {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) out[key] = (before as unknown as Record<string, unknown>)[key] ?? null;
  return out as SettingsPatch;
}

/** The row's value in words: its own `valueText`, or "<label>: On/Off/<value>". */
export function sayValue(row: RowDef, settings: Settings): string {
  if (row.valueText) return row.valueText(settings);
  const key = row.keys?.[0];
  const value = key ? settings[key] : undefined;
  const fallback = key ? SETTING_DEFAULTS[key] : undefined;
  const shown = value ?? fallback;
  const text = typeof shown === 'boolean' ? (shown ? 'On' : 'Off') : shown === undefined || shown === null || shown === '' ? 'Not set' : String(shown);
  return `${row.label}: ${text}`;
}

/** The rows that differ from the default, grouped by page in nav order (pages with none are left out). */
export function changedRows(sections: SectionDef[], settings: Settings | null): { section: SectionDef; rows: RowDef[] }[] {
  if (!settings) return [];
  return sections
    .map((section) => ({ section, rows: section.rows.filter((row) => isChanged(row, settings)) }))
    .filter((hit) => hit.rows.length > 0);
}

export function countChanged(sections: SectionDef[], settings: Settings | null): number {
  return changedRows(sections, settings).reduce((n, hit) => n + hit.rows.length, 0);
}
