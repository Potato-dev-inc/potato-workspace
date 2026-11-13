// Settings > General > Labs > Red to Green. Off by default. Shows the GitHub sign-in, the four caps (tries per
// pull request, turns and minutes per try, fixes a day) and the pull requests Potato Workspace watches, with their
// buttons. Every change is one `ciFixSaveSettings` or one `ciFixAct`; the backend clamps the numbers again.
import { errorSentence } from '../../../lib/sayError';
import { en } from '../../../i18n/en';
import { t, useT } from '../../../i18n';
import { useCallback, useEffect, useState } from 'react';
import {
  ciFixAct,
  ciFixSaveSettings,
  ciFixView,
  onCiFixChanged,
  watchLine,
  type CiFixAction,
  type CiFixSettings as CiFixConfig,
  type CiFixView,
  type GhView,
  type WatchView,
} from '../../../lib/ci-fix';
import { NumberControl } from '../controls';
import { Btn, Note, SettingBlock, SettingRow, SettingToggle } from '../settings-ui';

/** The ranges of the four caps. The backend clamps to the same numbers. */
export const CAPS = {
  tries: { min: 1, max: 3 },
  turns: { min: 1, max: 50 },
  minutes: { min: 5, max: 60 },
  fixes: { min: 1, max: 20 },
} as const;

/** What the block promises. Shown as the footer; the only place "merge", "re-run" and "force" may appear. */
export const FOOTER = en['ci.footer'];

const errText = (e: unknown): string => (errorSentence(e));

/** The GitHub line under the switch: whose sign-in it is, or what to install. */
export function ciGhLine(gh: GhView): string {
  if (gh.state === 'ready') return gh.login ? t('intake.ghAs', { login: gh.login }) : t('intake.gh');
  return t('intake.ghInstall');
}

/** One button of a watched pull request row. `id` is the watch id, or the id of its last fix for "Ask again". */
export interface WatchButton {
  label: string;
  id: string;
  action: CiFixAction;
}

/** The buttons a watched row offers, in order: Stop watching, Watch again, then Ask again for a declined or expired fix. */
export function watchButtons(w: WatchView): WatchButton[] {
  const out: WatchButton[] = [];
  if (w.state === 'watching' || w.state === 'paused') out.push({ label: t('ci.stopWatching'), id: w.id, action: 'stop_watching' });
  if (w.state === 'paused' || w.state === 'stopped') out.push({ label: t('ci.watchAgain'), id: w.id, action: 'watch_again' });
  const fix = w.lastFix;
  if (fix && (fix.state === 'declined' || fix.state === 'expired')) out.push({ label: t('intake.askAgain'), id: fix.id, action: 'ask_again' });
  return out;
}

function WatchRow({ watch, busy, onAct }: { watch: WatchView; busy: boolean; onAct: (id: string, action: CiFixAction) => void }) {
  return (
    <li className="st-device" aria-label={`#${watch.prNumber} ${watch.repo}`}>
      <div className="st-device-head">
        <div className="st-label">
          <span>{watchLine(watch)}</span>
        </div>
        <div className="st-control">
          {watchButtons(watch).map((b) => (
            <Btn key={`${b.action}-${b.id}`} small disabled={busy} onClick={() => onAct(b.id, b.action)}>
              {b.label}
            </Btn>
          ))}
        </div>
      </div>
    </li>
  );
}

export function CiFixSettings({ onSaved }: { onSaved?: () => void }) {
  const t = useT();
  const [view, setView] = useState<CiFixView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await ciFixView());
      setError(null);
    } catch (e) {
      // No desktop shell (a browser preview) or the backend is not ready: say so, do not crash.
      setError(t('intake.readFailed', { reason: errText(e) }));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let stop: (() => void) | undefined;
    void load();
    void onCiFixChanged(() => void load())
      .then((off) => {
        if (alive) stop = off;
        else off();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      stop?.();
    };
  }, [load]);

  /** Save the whole settings object. Errors show here; the view is replaced by what the backend returns. */
  const save = async (next: CiFixConfig) => {
    setBusy(true);
    setError(null);
    try {
      setView(await ciFixSaveSettings(next));
      onSaved?.();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: string, action: CiFixAction) => {
    setBusy(true);
    setError(null);
    try {
      setView(await ciFixAct(id, action));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!view) return error ? <Note role="alert">{error}</Note> : <Note role="status">{t('teamPage.loading')}</Note>;

  const { settings, gh, watches } = view;
  return (
    <>
      {error && <Note role="alert">{error}</Note>}
      <SettingToggle
        label={t('ci.offer')}
        description={t('ci.offerHelp')}
        checked={settings.enabled}
        disabled={busy}
        onChange={(on) => void save({ ...settings, enabled: on })}
      />
      <SettingRow label="GitHub" /* i18n-ok: product name */ description={ciGhLine(gh)} />
      <SettingRow label={t('ci.tries')} description={t('ci.triesHelp')}>
        <NumberControl
          aria-label={t('ci.tries')}
          min={CAPS.tries.min}
          max={CAPS.tries.max}
          value={settings.tries_per_pr}
          disabled={busy}
          onCommit={(next) => save({ ...settings, tries_per_pr: next })}
        />
      </SettingRow>
      <SettingRow label={t('ci.turns')} description={t('ci.turnsHelp')}>
        <NumberControl
          aria-label={t('ci.turns')}
          min={CAPS.turns.min}
          max={CAPS.turns.max}
          value={settings.turns_per_try}
          disabled={busy}
          onCommit={(next) => save({ ...settings, turns_per_try: next })}
        />
      </SettingRow>
      <SettingRow label={t('ci.minutes')} description={t('ci.minutesHelp')}>
        <NumberControl
          aria-label={t('ci.minutes')}
          min={CAPS.minutes.min}
          max={CAPS.minutes.max}
          value={settings.minutes_per_try}
          disabled={busy}
          onCommit={(next) => save({ ...settings, minutes_per_try: next })}
        />
      </SettingRow>
      <SettingRow label={t('ci.fixes')} description={t('ci.fixesHelp')}>
        <NumberControl
          aria-label={t('ci.fixes')}
          min={CAPS.fixes.min}
          max={CAPS.fixes.max}
          value={settings.fixes_per_day}
          disabled={busy}
          onCommit={(next) => save({ ...settings, fixes_per_day: next })}
        />
      </SettingRow>

      <SettingBlock label={t('ci.watched')} description={t('ci.watchedHelp')}>
        {watches.length === 0 ? (
          <Note>{t('ci.noPrs')}</Note>
        ) : (
          <ul className="st-devices" aria-label={t('ci.watched')}>
            {watches.map((w) => (
              <WatchRow key={w.id} watch={w} busy={busy} onAct={(id, action) => void act(id, action)} />
            ))}
          </ul>
        )}
      </SettingBlock>

      <Note>{t('ci.footer')}</Note>
    </>
  );
}
