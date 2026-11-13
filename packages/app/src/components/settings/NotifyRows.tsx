// Settings rows for notifications: the quiet hours (Look and feel) and one agent's bell (its Agents page).
// The choices are kept on the PC (`lib/notify-store`), so the phone and chat alerts obey them too.
import { useT } from '../../i18n';
import { BELL_LEVELS, type BellLevel, type QuietHours } from '../../lib/notify-levels';
import { useBellLevel, useQuietHours } from '../../lib/notify-store';
import { Popup, Switch } from './controls';
import { SettingRow } from './settings-ui';

const LEVEL_KEY = {
  everything: 'notify.level.everything',
  needs: 'notify.level.needs',
  finished: 'notify.level.finished',
  silent: 'notify.level.silent',
} as const;

/** "22:00" for minutes after midnight, and back. */
export const toClock = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
export function fromClock(value: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return fallback;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[1]) < 24 && Number(m[2]) < 60 ? minutes : fallback;
}

export function QuietHoursRow({ onSaved }: { onSaved?: () => void }) {
  const t = useT();
  const [quiet, setQuiet] = useQuietHours();
  const save = (next: QuietHours) => {
    setQuiet(next);
    onSaved?.();
  };
  return (
    <SettingRow label={t('notify.quiet.label')} description={t('notify.quiet.hint')}>
      <span className="st-quiet" data-testid="quiet-hours">
        {quiet.enabled && (
          <>
            <span className="st-aside">{t('notify.quiet.from')}</span>
            <input type="time" className="st-popup" aria-label={t('notify.quiet.fromAria')} value={toClock(quiet.start)} onChange={(e) => save({ ...quiet, start: fromClock(e.target.value, quiet.start) })} />
            <span className="st-aside">{t('notify.quiet.to')}</span>
            <input type="time" className="st-popup" aria-label={t('notify.quiet.toAria')} value={toClock(quiet.end)} onChange={(e) => save({ ...quiet, end: fromClock(e.target.value, quiet.end) })} />
          </>
        )}
        <Switch checked={quiet.enabled} label={t('notify.quiet.on')} onChange={(enabled) => save({ ...quiet, enabled })} />
      </span>
    </SettingRow>
  );
}

function BellPopup({ bellKey, isHelper, aria }: { bellKey: string; isHelper: boolean; aria: string }) {
  const t = useT();
  const [level, setLevel] = useBellLevel(bellKey, isHelper);
  return (
    <Popup aria-label={aria} value={level} onChange={(e) => setLevel(e.target.value as BellLevel)}>
      {BELL_LEVELS.map((option) => (
        <option key={option} value={option}>
          {t(LEVEL_KEY[option])}
        </option>
      ))}
    </Popup>
  );
}

/** One agent's page: its bell, and the bell for the helpers it starts (quieter by default). */
export function AgentNotifyRows({ agentId, label }: { agentId: string; label: string }) {
  const t = useT();
  return (
    <>
      <SettingRow label={t('notify.agent.label')} description={t('notify.agent.hint', { agent: label })}>
        <BellPopup bellKey={agentId} isHelper={false} aria={t('notify.agent.aria', { agent: label })} />
      </SettingRow>
      <SettingRow label={t('notify.agent.helperLabel')} description={t('notify.agent.helperHint', { agent: label })}>
        <BellPopup bellKey={`helper:${agentId}`} isHelper aria={t('notify.agent.helperAria', { agent: label })} />
      </SettingRow>
    </>
  );
}
