// "Check it in the browser" (R4-11): the card in a pane's Chat tab. It says pass or fail, lists what the page
// complained about and shows the picture the agent browser took. On a fail it can hand the list to the agent.
// Words that come from the page (the lines, the title) are drawn as plain text, never as markup.
import { useState } from 'react';
import { useT } from '../../i18n';
import type { CheckReport } from '../../lib/browser-check';
import '../../styles/check-card.css';

export interface CheckCardProps {
  report: CheckReport | null;
  busy: boolean;
  error: string | null;
  onAgain: () => void;
  onClose: () => void;
  /** Sends the problems to the pane's agent. Absent when the pane cannot take a message. */
  onFix?: (report: CheckReport) => void;
}

const SHOWN_LINES = 5;

export function CheckCard({ report, busy, error, onAgain, onClose, onFix }: CheckCardProps): JSX.Element {
  const t = useT();
  const [big, setBig] = useState(false);
  const verdict = report?.verdict ?? null;
  const tone = busy ? 'busy' : error ? 'fail' : (verdict ?? 'busy');
  const title = busy ? t('check.running') : error ? t('check.error') : verdict === 'pass' ? t('check.pass') : verdict === 'sign_in' ? t('check.signIn') : t('check.fail');
  const lines = report?.problems ?? [];
  return (
    <section className="ck-check" data-tone={tone} aria-label={t('check.label')} data-testid="check-card">
      <div className="ck-check-head">
        <span className="ck-check-badge" data-testid="check-verdict">
          {title}
        </span>
        <span className="ck-check-spacer" />
        <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" onClick={onAgain} disabled={busy}>
          {t('check.again')}
        </button>
        <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" onClick={onClose}>
          {t('check.close')}
        </button>
      </div>
      {error && !busy && (
        <p className="ck-check-note" role="alert">
          {error}
        </p>
      )}
      {report && !busy && (
        <>
          <p className="ck-check-url" title={report.url}>
            {report.url}
          </p>
          {verdict === 'sign_in' && <p className="ck-check-note">{t('check.signInHelp')}</p>}
          {verdict === 'fail' && !report.loaded && <p className="ck-check-note">{t('check.notLoaded')}</p>}
          {lines.length > 0 && (
            <ul className="ck-check-list" aria-label={t('check.problems', { n: report.problem_count })}>
              {lines.slice(0, SHOWN_LINES).map((line, i) => (
                <li key={i}>{line}</li>
              ))}
              {report.problem_count > SHOWN_LINES && <li className="ck-check-more">{t('check.more', { n: report.problem_count - SHOWN_LINES })}</li>}
            </ul>
          )}
          {verdict === 'pass' && <p className="ck-check-note">{t('check.passHelp')}</p>}
          {report.screenshot && (
            <button type="button" className="ck-check-shot" aria-label={t('check.enlarge')} onClick={() => setBig(true)}>
              <img src={report.screenshot} alt={t('check.shotAlt')} />
            </button>
          )}
          {verdict === 'fail' && lines.length > 0 && onFix && (
            <div className="ck-check-foot">
              <button type="button" className="ck-btn ck-btn--sm" onClick={() => onFix(report)}>
                {t('check.fix')}
              </button>
            </div>
          )}
          {big && report.screenshot && (
            <div className="ck-check-big" role="dialog" aria-label={t('check.enlarge')} onClick={() => setBig(false)}>
              <img src={report.screenshot} alt="" />
            </div>
          )}
        </>
      )}
    </section>
  );
}
