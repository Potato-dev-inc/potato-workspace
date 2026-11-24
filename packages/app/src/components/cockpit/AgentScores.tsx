// "Scores on your code": which agent works best in this project, from your own history.
// One dense table, a scope and window switcher, and plain notes about what is counted.
// No folder path, pane id or chat text: the backend never sends them (`scores`). No ranking, no stars, no overall score.
import { errorSentence } from '../../lib/sayError';
import { useEffect, useState } from 'react';
import { t, useT } from '../../i18n';
import { backendText } from '../../lib/backendWords';
import {
  aheadTitle,
  SCORE_WINDOWS,
  brokeTestsText,
  detailLine,
  notEnoughText,
  percentText,
  perMergedText,
  rateText,
  sampleHint,
  scoresApi,
  windowLabel,
  type ScoreAheadKey,
  type ScoreRate,
  type ScoreRow,
  type ScoresApi,
  type ScoresReport,
} from '../../lib/agent-scores';
import '../../styles/cockpit-scores.css';

type Scope = 'project' | 'all';

/** The table columns after the agent name. Captions are the one-line explanations under each header. */
const COLUMNS = [
  { id: 'turns', label: 'r21.sc.turns', caption: 'r21.sc.turnsCap' },
  { id: 'endedOk', label: 'r21.sc.endedOk', caption: 'r21.sc.endedOkCap' },
  { id: 'checksGreen', label: 'r21.sc.checks', caption: 'r21.sc.checksCap' },
  { id: 'merged', label: 'r21.sc.merged', caption: 'r21.sc.mergedCap' },
  { id: 'undone', label: 'r21.sc.undone', caption: 'r21.sc.undoneCap' },
  { id: 'perMerged', label: 'r21.sc.perMerged', caption: 'r21.sc.perMergedCap' },
  { id: 'askedYou', label: 'r21.sc.asked', caption: 'r21.sc.askedCap' },
] as const;

/** Read by the "How to read this" list: one short line per column that needs explaining. */
const HOW_TO_READ = ['r21.sc.how1', 'r21.sc.how2', 'r21.sc.how3', 'r21.sc.how4', 'r21.sc.how5', 'r21.sc.how6'] as const;

const HOW_TO_READ_END = ['r21.sc.end1', 'r21.sc.end2', 'r21.sc.end3', 'r21.sc.end4'] as const;

function cls(...names: (string | false | null | undefined)[]): string | undefined {
  const out = names.filter(Boolean).join(' ');
  return out === '' ? undefined : out;
}

/** One rate cell: "8 of 10", a muted "early" tag, the steady percent, or a dash with the reason. */
function RateCell({ rate, ahead, minSample }: { rate: ScoreRate; ahead: boolean; minSample: number }) {
  const hint = sampleHint(rate, minSample);
  if (hint !== null) {
    return (
      <td className="is-num is-none" title={hint}>
        -
      </td>
    );
  }
  const pct = percentText(rate);
  return (
    <td className={cls('is-num', rate.sample === 'early' && 'is-early')}>
      {rateText(rate)}
      {pct !== null && <span className="ck-scores-pct">{pct}</span>}
      {rate.sample === 'early' && <span className="ck-scores-tag">{t('r9.sc.early')}</span>}
      {ahead && (
        <span className="ck-scores-ahead" title={aheadTitle()}>
          {t('r21.sc.ahead')}
        </span>
      )}
    </td>
  );
}

function ScoreTableRow({ row, minSample }: { row: ScoreRow; minSample: number }) {
  const ahead = new Set<ScoreAheadKey>(row.ahead);
  const detail = detailLine(row);
  const broke = brokeTestsText(row);
  const name = (
    <th scope="row">
      <span className="ck-scores-agent">{row.agentLabel}</span>
      <span className="ck-scores-account">{backendText(row.accountLabel)}</span>
      {detail !== '' && <span className="ck-scores-detail">{detail}</span>}
      {broke !== null && <span className="ck-scores-broke">{broke}</span>}
    </th>
  );
  if (!row.enough) {
    return (
      <tr className="ck-scores-notenough">
        {name}
        <td colSpan={COLUMNS.length}>{notEnoughText(row)}</td>
      </tr>
    );
  }
  const perMerged = perMergedText(row.perMerged);
  return (
    <tr>
      {name}
      <td className="is-num">{row.turns}</td>
      <RateCell rate={row.endedOk} ahead={ahead.has('endedOk')} minSample={minSample} />
      <RateCell rate={row.checksGreen} ahead={ahead.has('checksGreen')} minSample={minSample} />
      <RateCell rate={row.merged} ahead={ahead.has('merged')} minSample={minSample} />
      <RateCell rate={row.undone} ahead={ahead.has('undone')} minSample={minSample} />
      {perMerged === null ? (
        <td className="is-num is-none" title={t('r9.sc.needs3')}>
          -
        </td>
      ) : (
        <td className="is-num">{perMerged}</td>
      )}
      <RateCell rate={row.askedYou} ahead={false} minSample={minSample} />
    </tr>
  );
}

export function AgentScores({
  api = scoresApi,
  project,
  onClose,
}: {
  api?: ScoresApi;
  /** The folder of the selected pane. Only the name is shown; the path goes to the backend. */
  project?: { path: string; name: string } | null;
  onClose: () => void;
}) {
  useT();
  const [scope, setScope] = useState<Scope>(project ? 'project' : 'all');
  const [projectKey, setProjectKey] = useState<string | undefined>(project?.path);
  const [days, setDays] = useState<number | null>(90);
  const [report, setReport] = useState<ScoresReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .report(scope === 'project' ? projectKey : undefined, days)
      .then((next) => {
        if (!live) return;
        setReport(next);
        setError(null);
      })
      .catch((e) => live && setError(errorSentence(e)));
    return () => {
      live = false;
    };
  }, [api, scope, projectKey, days]);

  const projectName = project?.name ?? report?.project?.label;
  const projects = report?.projects ?? [];
  const enoughCount = report ? report.rows.filter((r) => r.enough).length : 0;

  return (
    <div className="ck-scores">
      <header className="ck-memory-head">
        <div>
          <h1 className="ck-title">{t('r9.sc.title')}</h1>
          <p className="ck-sub">{t('r9.sc.sub')}</p>
        </div>
        <button type="button" className="ck-btn ck-btn--plain" onClick={onClose}>
          {t('r9.sc.close')}
        </button>
      </header>

      <div className="ck-scores-controls">
        <div className="ck-scores-scope" role="group" aria-label={t('r9.sc.scope')}>
          <button
            type="button"
            aria-pressed={scope === 'project'}
            className={cls(scope === 'project' && 'is-on')}
            disabled={!project}
            onClick={() => setScope('project')}
          >
            {projectName ? t('r9.sc.thisProjectNamed', { name: projectName }) : t('r9.sc.thisProject')}
          </button>
          <button
            type="button"
            aria-pressed={scope === 'all'}
            className={cls(scope === 'all' && 'is-on')}
            onClick={() => setScope('all')}
          >
            {t('r9.sc.all')}
          </button>
        </div>

        <div className="ck-scores-scope" role="group" aria-label={t('r9.sc.filters')}>
          {scope === 'project' && projects.length > 0 && (
            <select
              className="ck-scores-select"
              aria-label={t('r9.sc.project')}
              value={report?.project?.id ?? ''}
              onChange={(e) => setProjectKey(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          )}
          <select
            className="ck-scores-select"
            aria-label={t('r9.sc.window')}
            value={days === null ? 'all' : String(days)}
            onChange={(e) => setDays(e.target.value === 'all' ? null : Number(e.target.value))}
          >
            {SCORE_WINDOWS.map((d) => (
              <option key={d ?? 'all'} value={d === null ? 'all' : String(d)}>
                {windowLabel(d)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <p className="ck-scores-error" role="alert">
          {error}
        </p>
      )}

      {report === null && error === null && <p className="ck-scores-empty">{t('r9.sc.loading')}</p>}

      {report !== null && report.rows.length === 0 && (
        <p className="ck-scores-empty">{t('r9.sc.none')}</p>
      )}

      {report !== null && report.rows.length > 0 && (
        <>
          <div className="ck-scores-scroll">
            <table className="ck-scores-table">
              <thead>
                <tr>
                  <th scope="col">{t('r9.sc.agent')}</th>
                  {COLUMNS.map((c) => (
                    <th key={c.id} scope="col" className="is-num" aria-describedby={`ck-scores-cap-${c.id}`}>
                      {t(c.label)}
                      <span className="ck-scores-caption" id={`ck-scores-cap-${c.id}`}>
                        {t(c.caption)}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <ScoreTableRow key={`${row.agentId}\u0000${row.accountId ?? ''}`} row={row} minSample={report.minSample} />
                ))}
              </tbody>
            </table>
          </div>
          {enoughCount === 1 && <p className="ck-scores-empty">{t('r9.sc.one')}</p>}
        </>
      )}

      <details className="ck-scores-how">
        <summary>{t('r9.sc.how')}</summary>
        <ul>
          {HOW_TO_READ.map((line) => (
            <li key={line}>{t(line)}</li>
          ))}
          {HOW_TO_READ_END.map((line) => (
            <li key={line}>{t(line)}</li>
          ))}
        </ul>
      </details>

      {report !== null && report.notes.length > 0 && (
        <ul className="ck-scores-notes">
          {report.notes.map((note) => (
            <li key={note}>{backendText(note)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
