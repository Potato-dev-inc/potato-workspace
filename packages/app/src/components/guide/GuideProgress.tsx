// A run in plain words: what it is doing, how many pages are done, and a Stop button that is always there.
import { useT, type MessageKey } from '../../i18n';
import { isRunning, type GuideApi, type GuideRun } from '../../lib/guide';

const PHASE: Record<GuideRun['phase'], MessageKey> = {
  look: 'guide.phaseLook',
  outline: 'guide.phaseOutline',
  pages: 'guide.phasePages',
  diagram: 'guide.phaseDiagram',
  done: 'guide.phaseDone',
  stopped: 'guide.phaseStopped',
  failed: 'guide.phaseFailed',
};

export function GuideProgress({ paneId, api, run }: { paneId: string; api: GuideApi; run: GuideRun }) {
  const t = useT();
  const running = isRunning(run);
  const pct = run.pagesTotal > 0 ? Math.min(100, Math.round((run.pagesDone / run.pagesTotal) * 100)) : 0;
  return (
    <section className="ck-guide-card" aria-label={t('guide.progressLabel')} data-testid="guide-progress">
      <h2 role="status">{t(PHASE[run.phase])}</h2>
      {run.pagesTotal > 0 && (
        <>
          <div className="ck-guide-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span style={{ width: `${pct}%` }} />
          </div>
          <p className="ck-guide-fine">{t('guide.progressCount', { done: run.pagesDone, total: run.pagesTotal })}</p>
        </>
      )}
      {run.error && (
        <p className="ck-guide-fine" role="alert">
          {run.error}
        </p>
      )}
      {run.notes.map((n) => (
        <p key={n} className="ck-guide-fine">
          {n}
        </p>
      ))}
      {running && (
        <div className="ck-guide-actions">
          <button type="button" className="ck-btn ck-btn--secondary" onClick={() => void api.stop(paneId)}>
            {t('guide.stop')}
          </button>
        </div>
      )}
    </section>
  );
}
