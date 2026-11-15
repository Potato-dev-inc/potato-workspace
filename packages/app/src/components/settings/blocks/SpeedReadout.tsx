// Settings > General: "Speed on this PC". The times the app already measured (opening the app step by step, starting a
// chat, the first sign of an answer, how often a ready-made session was used, checking the setup) in a small table,
// with a marker on the slow ones and "Copy for support". Worked out on this PC from the app's own log. Nothing is sent.
import { useEffect, useState } from 'react';
import { useT } from '../../../i18n';
import { tauri, type PerfSummary } from '../../../lib/tauri';
import { Btn, SettingBlock } from '../settings-ui';
import { speedRows, speedText } from './speedReport';

export function SpeedReadout() {
  const t = useT();
  const [summary, setSummary] = useState<PerfSummary | null | undefined>(undefined);
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null);

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
  const rows = summary ? speedRows(summary) : [];

  const copy = () => {
    setCopied(null);
    navigator.clipboard.writeText(speedText(rows)).then(
      () => setCopied('done'),
      () => setCopied('failed'),
    );
  };

  return (
    <SettingBlock label={t('speed.title')} description={t('speed.help')}>
      {rows.length === 0 ? (
        <p className="st-note">{t('speed.none')}</p>
      ) : (
        <>
          <table className="st-speed-table" aria-label={t('speed.table')}>
            <thead>
              <tr>
                <th scope="col">{t('speed.col.what')}</th>
                <th scope="col">{t('speed.col.usual')}</th>
                <th scope="col">{t('speed.col.last')}</th>
                <th scope="col">{t('speed.col.times')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-speed-row={r.id} data-slow={r.slow ? 'true' : undefined}>
                  <th scope="row">{r.label}</th>
                  <td>
                    {r.usual}
                    {r.slow && (
                      <span className="st-speed-slow" data-testid="speed-slow">
                        {' '}
                        {r.mark}
                      </span>
                    )}
                  </td>
                  <td>{r.last}</td>
                  <td>{r.times}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="st-speed-actions">
            <Btn small onClick={copy}>
              {t('speed.copy')}
            </Btn>
            {copied && (
              <span role="status" className="st-note">
                {copied === 'done' ? t('speed.copied') : t('speed.copyFailed')}
              </span>
            )}
          </div>
        </>
      )}
    </SettingBlock>
  );
}
