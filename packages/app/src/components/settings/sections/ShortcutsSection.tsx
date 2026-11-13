// Settings > Shortcuts: every keyboard shortcut you can change, by group. "Change" listens for the next key
// combination (Esc cancels), tells you when another shortcut or a terminal already uses it (you may still use it),
// and saves the one `keybindings` setting. "Turn off" and "Reset" are per row, "Reset all" is one row at the end.
// Shortcuts that work from any app are also tried with the OS by Rust (`global_shortcut_set`); when the OS says no,
// the old keys stay and the row says why.
import { invoke } from '@tauri-apps/api/core';
import { t, useT } from '../../../i18n';
import { translateOr } from '../i18n-labels';
import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  BINDABLE,
  DISABLED,
  SHORTCUT_GROUPS,
  bindingLabel,
  checkBinding,
  defaultBinding,
  effectiveBinding,
  formatKey,
  isMacPlatform,
  normalizeBinding,
  recordKey,
  sanitizeKeybindings,
  setKeybindings,
  setShortcutRecording,
  type BindingProblem,
  type Keybindings,
  type ShortcutEntry,
} from '../../../lib/shortcuts';
import type { RowDef, SettingsEnv } from '../model';
import { Btn, Note, SettingRow } from '../settings-ui';

export interface GlobalStatus {
  id: string;
  active: string | null;
  note: string | null;
  switched_on: boolean;
}

/** What the OS-level shortcuts need from Rust. Replaced in tests. */
export const shortcutsApi = {
  /** Tries the combo with the OS. `null`: back to the default. Rejects with the reason when it is refused. */
  async globalSet(id: string, combo: string | null): Promise<void> {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    await invoke('global_shortcut_set', { id, combo });
  },
  async globalStatus(): Promise<GlobalStatus[]> {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return [];
    return invoke<GlobalStatus[]>('global_shortcuts_status');
  },
};

function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  return e instanceof Error ? e.message : t('shortcuts.couldNot');
}

type Phase = { kind: 'idle' } | { kind: 'recording' } | { kind: 'confirm'; binding: string; warnings: BindingProblem[] };

function useGlobalNote(entry: ShortcutEntry, version: number): string | null {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (entry.bind?.scope !== 'global') return;
    let alive = true;
    shortcutsApi
      .globalStatus()
      .then((all) => {
        if (alive) setNote(all.find((s) => s.id === entry.id)?.note ?? null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [entry, version]);
  return note;
}

function ShortcutRow({ entry, env }: { entry: ShortcutEntry; env: SettingsEnv }) {
  const t = useT();
  const label = translateOr(`settings.row.shortcut-${entry.id}.label`, entry.label);
  const mac = isMacPlatform();
  const overrides: Keybindings = sanitizeKeybindings(env.settings.keybindings);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saves, setSaves] = useState(0);
  const global = entry.bind?.scope === 'global';
  const note = useGlobalNote(entry, saves);

  // While the box listens, the app's own shortcuts must not fire (Ctrl+K would open the palette).
  useEffect(() => {
    setShortcutRecording(phase.kind === 'recording');
    return () => setShortcutRecording(false);
  }, [phase.kind]);

  const current = effectiveBinding(entry.id, overrides, mac);
  const fallback = defaultBinding(entry.id, mac);
  const changed = overrides[entry.id] !== undefined;

  /** Saves `value`: a combo, `DISABLED`, or null for "back to the default". */
  const save = async (value: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const same = value !== null && value !== DISABLED && normalizeBinding(value) === normalizeBinding(fallback ?? '');
      const stored = value === null || same ? null : value;
      if (global) await shortcutsApi.globalSet(entry.id, stored);
      // In a merge patch, null removes the key: the shortcut goes back to its default.
      await env.patch({ keybindings: { [entry.id]: stored } as unknown as Keybindings });
      const next = { ...overrides };
      if (stored === null) delete next[entry.id];
      else next[entry.id] = stored;
      setKeybindings(next);
      setSaves((n) => n + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setPhase({ kind: 'idle' });
    }
  };

  const consider = (binding: string) => {
    if (binding === current) {
      setPhase({ kind: 'idle' });
      return;
    }
    const check = checkBinding(entry.id, binding, overrides, mac);
    if (check.error) {
      setError(check.error);
      setPhase({ kind: 'idle' });
    } else if (check.warnings.length > 0) {
      setError(null);
      setPhase({ kind: 'confirm', binding, warnings: check.warnings });
    } else {
      void save(binding);
    }
  };

  const onKey = (e: ReactKeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const result = recordKey(e.nativeEvent, mac);
    if (result.kind === 'cancel') setPhase({ kind: 'idle' });
    else if (result.kind === 'combo') consider(result.binding);
  };

  const shown = current ? bindingLabel(entry.id, mac, overrides) : t('telegram.off');
  return (
    <SettingRow label={label} description={entry.bind?.digits ? describe(entry) : undefined}>
      <div className="st-shortcut" data-shortcut={entry.id}>
        {phase.kind === 'recording' ? (
          <button type="button" className="st-btn is-small" autoFocus aria-label={t('shortcuts.pressAria', { label })} onKeyDown={onKey} onBlur={() => setPhase({ kind: 'idle' })}>
            {t('shortcuts.press')}
          </button>
        ) : (
          <>
            {global && <span className="st-anyapp">{t('shortcuts.anyApp')}</span>}
            {/* The keys are the button: click them to change. */}
            <button
              type="button"
              className="st-keycap"
              data-off={current === null ? 'true' : undefined}
              disabled={busy}
              title={t('shortcuts.clickChange')}
              aria-label={t('shortcuts.changeAria', { label, shown })}
              onClick={() => {
                setError(null);
                setPhase({ kind: 'recording' });
              }}
            >
              {shown}
            </button>
            {current !== null && (
              <Btn small className="st-turnoff" disabled={busy} aria-label={t('shortcuts.turnOffAria', { label })} onClick={() => void save(DISABLED)}>
                {t('shortcuts.turnOff')}
              </Btn>
            )}
            {changed && (
              <Btn small disabled={busy} aria-label={t('shortcuts.resetAria', { label, to: fallback ? formatKey(fallback, mac) : t('shortcuts.itsDefault') })} onClick={() => void save(null)}>
                {t('settings.reset')}
              </Btn>
            )}
          </>
        )}
        {phase.kind === 'confirm' && (
          <div role="alert" className="st-shortcut-warn">
            <Note role="alert">{phase.warnings.map((w) => w.message).join(' ')}</Note>
            <Btn small primary disabled={busy} onClick={() => void save(phase.binding)}>
              {t('shortcuts.useAnyway', { keys: formatKey(phase.binding, mac) })}
            </Btn>
            <Btn small disabled={busy} onClick={() => setPhase({ kind: 'recording' })}>
              {t('shortcuts.pickAnother')}
            </Btn>
            <Btn small disabled={busy} onClick={() => setPhase({ kind: 'idle' })}>
              {t('lend.cancel')}
            </Btn>
          </div>
        )}
        {error && <Note role="alert">{error}</Note>}
        {!error && note && <Note role="status">{note}</Note>}
      </div>
    </SettingRow>
  );
}

function describe(entry: ShortcutEntry): string {
  if (entry.bind?.digits) return t('shortcuts.hintDigits');
  if (entry.bind?.scope === 'global') return t('shortcuts.hintGlobal');
  return t('shortcuts.hintFront');
}

function ResetAll({ env }: { env: SettingsEnv }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const overrides = sanitizeKeybindings(env.settings.keybindings);
  const count = Object.keys(overrides).length;
  const run = async () => {
    const ok = await env.confirm({ title: t('shortcuts.resetAllTitle'), body: t('shortcuts.resetAllBody'), confirmLabel: t('settings.resetAll') });
    if (!ok) return;
    setBusy(true);
    env.setError(null);
    try {
      for (const entry of BINDABLE.filter((b) => b.bind?.scope === 'global')) await shortcutsApi.globalSet(entry.id, null);
      await env.patch({ keybindings: null });
      setKeybindings({});
    } catch (e) {
      env.setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingRow label={t('settings.row.shortcuts-reset-all.label')} description={t('settings.row.shortcuts-reset-all.hint')}>
      <Btn small disabled={busy || count === 0} onClick={() => void run()}>
        {t('settings.resetAll')}
      </Btn>
    </SettingRow>
  );
}

const KEYWORDS = 'keyboard keys hotkey hotkeys shortcut shortcuts keybinding rebind remap change';

export const shortcutsRows: RowDef[] = [
  ...SHORTCUT_GROUPS.flatMap((group) =>
    BINDABLE.filter((entry) => entry.group === group).map(
      (entry): RowDef => ({
        id: `shortcut-${entry.id}`,
        label: entry.label,
        hint: describe(entry),
        keywords: `${KEYWORDS} ${entry.id.replace(/-/g, ' ')}`,
        group,
        render: (env) => <ShortcutRow entry={entry} env={env} />,
      }),
    ),
  ),
  {
    id: 'shortcuts-reset-all',
    label: 'Reset all shortcuts',
    hint: 'Puts every shortcut back to the keys it came with.',
    keywords: `${KEYWORDS} reset default restore`,
    group: 'Reset',
    render: (env) => <ResetAll env={env} />,
  },
];
