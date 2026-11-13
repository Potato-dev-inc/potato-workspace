// Settings > General: "Speed on this PC". Typical and latest times for starting the app and a chat,
// worked out on this PC from the app's own log. Nothing is sent anywhere.
import { useEffect, useState } from 'react';
import { t, useT } from '../../../i18n';
import { tauri, type PerfStat, type PerfSummary } from '../../../lib/tauri';
import { SettingBlock } from '../settings-ui';

function seconds(ms: number): string {
  return ms < 950 ? t('speed.ms', { n: Math.round(ms / 10) * 10 }) : t('speed.s', { n: (ms / 1000).toFixed(1) });
}

function describe(stat: PerfStat): string | null {
  if (stat.count === 0 || stat.medianMs === null) return null;
  const last = stat.lastMs === null ? '' : t('speed.last', { time: seconds(stat.lastMs) });
  return t('speed.usually', { time: seconds(stat.medianMs), last, count: stat.count });
}

const LINES: { key: keyof PerfSummary }[] = [{ key: 'appStart' }, { key: 'chatWarm' }, { key: 'chatCold' }, { key: 'handshake' }];

export function SpeedReadout() {
  const t = useT();
  const [summary, setSummary] = useState<PerfSummary | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    tauri
      .perfSummary()
      .then((s) => live && setSummary(s))
      .catch(() => live && setSummary(null));
    return () => {
      live = false;
    };
  }, []);

  if (summary === undefined) return null;
  const rows = summary ? LINES.map((l) => ({ ...l, label: t(`speed.line.${l.key}`), text: describe(summary[l.key]) })).filter((r) => r.text) : [];
  return (
    <SettingBlock
      label={t('speed.title')}
      description={t('speed.help')}
    >
      {rows.length === 0 ? (
        <p className="st-note">{t('speed.none')}</p>
      ) : (
        <ul className="st-diag-list" aria-label={t('speed.title')}>
          {rows.map((r) => (
            <li key={r.key} className="st-diag-item">
              <span className="st-diag-main">
                <span className="st-diag-name">{r.label}</span>
                <span className="st-diag-size">{r.text}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </SettingBlock>
  );
}
