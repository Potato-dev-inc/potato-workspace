// "Your plans this month": what each subscription (an agent under one account) did, side by side.
// One dense table, a month switcher, and the plain notes about what is and is not counted.
// No folder, no chat text: the backend never sends them (`plans_report`).
import { errorSentence } from '../../lib/sayError';
import { t, useT } from '../../i18n';
import { backendText } from '../../lib/backendWords';
import { useEffect, useState } from 'react';
import {
  filesText,
  formatBusy,
  limitsText,
  mergedText,
  neighbour,
  plansApi,
  turnsText,
  type PlansApi,
  type PlansReport,
} from '../../lib/plans-report';
import { plansCsv, plansSummaryText } from '../../lib/plans-copy';
import '../../styles/cockpit-plans.css';

type CopyKind = 'csv' | 'text';

export function PlansMonth({ api = plansApi, onClose }: { api?: PlansApi; onClose: () => void }) {
  useT();
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [report, setReport] = useState<PlansReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<CopyKind | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .report(month)
      .then((next) => {
        if (!live) return;
        setReport(next);
        setError(null);
      })
      .catch((e) => live && setError(errorSentence(e)));
    return () => {
      live = false;
    };
  }, [api, month]);

  // "Copied" goes away after 1.5 s.
  useEffect(() => {
    if (copied === null) return;
    const t = window.setTimeout(() => setCopied(null), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);

  async function copy(kind: CopyKind, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFailed(false);
      setCopied(kind);
    } catch {
      setCopied(null);
      setCopyFailed(true);
    }
  }

  const months = report?.months ?? [];
  const here = report?.month.id ?? '';
  const older = report ? neighbour(months, here, 'older') : null;
  const newer = report ? neighbour(months, here, 'newer') : null;
  const isCurrent = report !== null && months[0]?.id === report.month.id;
  const title = report === null || isCurrent ? t('r21.plans.title') : t('r21.plans.titleIn', { month: report.month.label });

  return (
    <div className="ck-plans">
      <header className="ck-memory-head">
        <div>
          <h1 className="ck-title">{title}</h1>
          <p className="ck-sub">{t('r21.plans.sub')}</p>
        </div>
        <button type="button" className="ck-btn ck-btn--plain" onClick={onClose}>
          {t('r21.plans.close')}
        </button>
      </header>

      <div className="ck-plans-bar">
        <div className="ck-plans-months" role="group" aria-label={t('r21.plans.month')}>
          <button
            type="button"
            className="ck-icon-btn"
            aria-label={t('r21.plans.earlier')}
            disabled={older === null}
            onClick={() => older && setMonth(older)}
          >
            {'‹'}
          </button>
          <select
            className="ck-plans-select"
            aria-label={t('r21.plans.month')}
            value={here}
            disabled={report === null}
            onChange={(e) => setMonth(e.target.value)}
          >
            {report === null && <option value="">{t('r21.plans.loading')}</option>}
            {months.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="ck-icon-btn"
            aria-label={t('r21.plans.later')}
            disabled={newer === null}
            onClick={() => newer && setMonth(newer)}
          >
            {'›'}
          </button>
        </div>

        {report !== null && report.rows.length > 0 && (
          <div className="ck-plans-copy" role="group" aria-label={t('r21.plans.copy')}>
            <button type="button" className="ck-btn ck-btn--plain" onClick={() => copy('csv', plansCsv(report.rows))}>
              {copied === 'csv' ? t('r21.plans.copied') : t('r21.plans.csv')}
            </button>
            <button type="button" className="ck-btn ck-btn--plain" onClick={() => copy('text', plansSummaryText(report.rows))}>
              {copied === 'text' ? t('r21.plans.copied') : t('r21.plans.text')}
            </button>
            {copyFailed && (
              <span className="ck-plans-copy-note" role="status">
                {t('r21.plans.copyFailed')}
              </span>
            )}
          </div>
        )}
      </div>

      {error && (
        <p className="ck-plans-error" role="alert">
          {error}
        </p>
      )}

      {report !== null && report.rows.length === 0 && <p className="ck-plans-empty">{t('r21.plans.noTurns')}</p>}

      {report !== null && report.rows.length > 0 && (
        <div className="ck-plans-scroll">
          <table className="ck-plans-table">
            <thead>
              <tr>
                <th scope="col">{t('r21.plans.colPlan')}</th>
                <th scope="col" className="is-num">
                  {t('r21.plans.colTurns')}
                </th>
                <th scope="col" className="is-num">
                  {t('r21.plans.colTime')}
                </th>
                <th scope="col">{t('r21.plans.colFiles')}</th>
                <th scope="col" className="is-num">
                  {t('r21.plans.colMerged')}
                </th>
                <th scope="col">{t('r21.plans.colLimits')}</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={`${row.agentId}\u0000${row.accountId ?? ''}`}>
                  <th scope="row">
                    <span className="ck-plans-agent">{row.agentLabel}</span>
                    <span className="ck-plans-account">{backendText(row.accountLabel)}</span>
                  </th>
                  <td className="is-num">{turnsText(row.turns)}</td>
                  <td className="is-num">{formatBusy(row.busyMs)}</td>
                  <td>{filesText(row.files)}</td>
                  <td className="is-num">{mergedText(row.merged)}</td>
                  <td className={row.limits.hits > 0 || row.limits.limitedMs > 0 ? 'is-hit' : 'is-quiet'}>{limitsText(row.limits)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">{t('r21.plans.all')}</th>
                <td className="is-num">{turnsText(report.totals.turns)}</td>
                <td className="is-num">{formatBusy(report.totals.busyMs)}</td>
                <td>
                  {report.totals.filesChanged === 0
                    ? '—'
                    : filesText({ knownTurns: 1, changed: report.totals.filesChanged, added: report.totals.added, deleted: report.totals.deleted })}
                </td>
                <td className="is-num">{mergedText(report.totals.merged)}</td>
                <td>{limitsText({ hits: report.totals.limitHits, limitedMs: report.totals.limitedMs })}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {report !== null && report.notes.length > 0 && (
        <ul className="ck-plans-notes">
          {report.notes.map((note) => (
            <li key={note}>{backendText(note)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
