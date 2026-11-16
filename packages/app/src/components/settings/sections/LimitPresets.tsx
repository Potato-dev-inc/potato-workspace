// The one picker for a limit: No limit, Light, Normal, Heavy, or Custom (which opens the numbers). Each preset sets
// several numbers at once; a set of numbers that matches no preset shows as Custom. Shared by the agent budget
// (BudgetRows.tsx) and the project budget (ProjectBudgetRows.tsx).
import { useState, type ReactNode } from 'react';
import { useT } from '../../../i18n';
import { Popup } from '../controls';

export type PresetName = 'none' | 'light' | 'normal' | 'heavy';
export type PresetTable<V> = Record<PresetName, V>;

/** The preset a set of values is, or 'custom' when none of them match. */
export function presetFor<V>(table: PresetTable<V>, value: V, same: (a: V, b: V) => boolean): PresetName | 'custom' {
  for (const name of Object.keys(table) as PresetName[]) if (same(table[name], value)) return name;
  return 'custom';
}

export function LimitPresetPicker<V>({
  table,
  value,
  same,
  aria,
  onPick,
  custom,
}: {
  table: PresetTable<V>;
  value: V;
  same: (a: V, b: V) => boolean;
  aria: string;
  onPick: (name: PresetName) => void;
  /** The number fields, shown when Custom is picked (or when the saved numbers match no preset). */
  custom: ReactNode;
}) {
  const t = useT();
  const current = presetFor(table, value, same);
  const [customOpen, setCustomOpen] = useState(current === 'custom');
  const shown = customOpen ? 'custom' : current;
  return (
    <div className="st-limit">
      <Popup
        aria-label={aria}
        value={shown}
        onChange={(event) => {
          const next = event.target.value;
          if (next === 'custom') {
            setCustomOpen(true);
            return;
          }
          setCustomOpen(false);
          onPick(next as PresetName);
        }}
      >
        <option value="none">{t('limits.none')}</option>
        <option value="light">{t('limits.light')}</option>
        <option value="normal">{t('limits.normal')}</option>
        <option value="heavy">{t('limits.heavy')}</option>
        <option value="custom">{t('limits.custom')}</option>
      </Popup>
      {customOpen && <div className="st-limit-custom">{custom}</div>}
    </div>
  );
}
