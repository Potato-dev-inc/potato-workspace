// Settings > General: "Speed on this PC". Typical and latest times for starting the app and a chat,
// worked out on this PC from the app's own log. Nothing is sent anywhere.
import { useEffect, useState } from 'react';
import { tauri, type PerfStat, type PerfSummary } from '../../../lib/tauri';
import { SettingBlock } from '../settings-ui';

function seconds(ms: number): string {
  return ms < 950 ? `${Math.round(ms / 10) * 10} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function describe(stat: PerfStat): string | null {
  if (stat.count === 0 || stat.medianMs === null) return null;
  const last = stat.lastMs === null ? '' : `, last time ${seconds(stat.lastMs)}`;
  return `usually ${seconds(stat.medianMs)}${last} (${stat.count} ${stat.count === 1 ? 'time' : 'times'})`;
}

const LINES: { key: keyof PerfSummary; label: string }[] = [
  { key: 'appStart', label: 'Opening the app' },
  { key: 'chatWarm', label: 'Starting a chat that was ready ahead of time' },
  { key: 'chatCold', label: 'Starting a chat from scratch' },
  { key: 'handshake', label: 'Waiting for the agent to say hello' },
];

export function SpeedReadout() {
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
  const rows = summary ? LINES.map((l) => ({ ...l, text: describe(summary[l.key]) })).filter((r) => r.text) : [];
  return (
    <SettingBlock
      label="Speed on this PC"
      description="Worked out here from the last 7 days of the app's own log. Nothing is sent anywhere."
    >
      {rows.length === 0 ? (
        <p className="st-note">Nothing measured yet. Numbers appear after you have used the app for a while.</p>
      ) : (
        <ul className="st-diag-list" aria-label="Speed on this PC">
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
