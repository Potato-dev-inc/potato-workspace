// The consent card (plan section 6): what a run will cost, shown before every run. Nothing starts when it opens; the
// run starts only when the person clicks "Make the guide" (or "Refresh the guide"), with the token this estimate got.
import { useEffect, useState } from 'react';
import { useT, type MessageKey } from '../../i18n';
import { DRY_RUN_AGENT, type GuideApi, type GuideEstimate, type GuideSize } from '../../lib/guide';
import { errorSentence } from '../../lib/sayError';

const SKIP_KEYS: Record<string, MessageKey> = {
  secret: 'guide.skipSecret',
  binary: 'guide.skipBinary',
  lock: 'guide.skipLock',
  generated: 'guide.skipGenerated',
  tooBig: 'guide.skipTooBig',
  ignored: 'guide.skipIgnored',
};

const SIZE_KEYS: Record<GuideSize, MessageKey> = { short: 'guide.sizeShort', normal: 'guide.sizeNormal', deep: 'guide.sizeDeep' };

export interface GuideSheetProps {
  paneId: string;
  api: GuideApi;
  project: string;
  /** The agent the pane runs: the default writer, and the name shown. */
  agentType: string;
  agentName: string;
  mode: 'make' | 'refresh';
  /** A development build can also write with the built-in stand-in. */
  dryRun: boolean;
  /** Called after the run was accepted, and when the person says "Not now". */
  onStarted: () => void;
  onCancel: () => void;
}

export function GuideSheet({ paneId, api, project, agentType, agentName, mode, dryRun, onStarted, onCancel }: GuideSheetProps) {
  const t = useT();
  const [size, setSize] = useState<GuideSize>('normal');
  const [writer, setWriter] = useState<string>(agentType);
  const [estimate, setEstimate] = useState<GuideEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Looking at the folder is free and starts nothing. A new size asks again (the token is for one run).
  useEffect(() => {
    let cancelled = false;
    setEstimate(null);
    api.estimate(paneId, size).then(
      (e) => !cancelled && setEstimate(e),
      (err: unknown) => !cancelled && setError(errorSentence(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [api, paneId, size]);

  const who = writer === DRY_RUN_AGENT ? t('guide.agentDry') : agentName;
  const go = () => {
    if (!estimate || busy) return;
    setBusy(true);
    api.start(paneId, { token: estimate.token, mode, size, agent: writer || undefined }).then(
      () => onStarted(),
      (err: unknown) => {
        setBusy(false);
        setError(errorSentence(err) || t('guide.startFailed'));
      },
    );
  };

  return (
    <section className="ck-guide-sheet" aria-label={t('guide.sheetLabel')} data-testid="guide-sheet">
      <h2>{mode === 'refresh' ? t('guide.sheetRefreshTitle', { project }) : t('guide.sheetTitle', { project })}</h2>
      {!estimate && !error && <p className="ck-guide-fine">{t('guide.sheetCounting')}</p>}
      {error && (
        <p className="ck-guide-fine" role="alert">
          {error}
        </p>
      )}
      {estimate && (
        <>
          <p>{mode === 'refresh' ? t('guide.sheetRefreshIntro', { agent: who }) : t('guide.sheetIntro', { agent: who, lo: estimate.pagesLo, hi: estimate.pagesHi })}</p>
          <dl className="ck-guide-rows">
            <dt>{t('guide.rowTime')}</dt>
            <dd>{t('guide.rowTimeValue', { lo: estimate.minutesLo, hi: estimate.minutesHi })}</dd>
            <dt>{t('guide.rowUsage')}</dt>
            <dd>{t('guide.rowUsageValue', { lo: estimate.chatsLo, hi: estimate.chatsHi })}</dd>
            <dt>{t('guide.rowReads')}</dt>
            <dd>{t('guide.rowReadsValue', { read: estimate.filesRead, skipped: estimate.filesSkipped })}</dd>
            <dt>{t('guide.rowStays')}</dt>
            <dd>{t('guide.rowStaysValue')}</dd>
          </dl>
          {!estimate.measured && <p className="ck-guide-fine">{t('guide.guess')}</p>}
          {estimate.tooSmall && <p className="ck-guide-fine">{t('guide.tooSmall')}</p>}
          {estimate.truncated && <p className="ck-guide-fine">{t('guide.truncated')}</p>}
          <details>
            <summary>{t('guide.details')}</summary>
            <p className="ck-guide-fine">{t('guide.detailsTokens', { lo: estimate.tokensMLo, hi: estimate.tokensMHi })}</p>
            <ul className="ck-guide-fine">
              {Object.entries(estimate.skippedByReason).map(([reason, n]) => (SKIP_KEYS[reason] ? <li key={reason}>{t(SKIP_KEYS[reason], { n })}</li> : null))}
            </ul>
          </details>
        </>
      )}
      <div className="ck-guide-pick">
        <label>
          {t('guide.writtenByLabel')}{' '}
          <select value={writer} onChange={(e) => setWriter(e.target.value)} aria-label={t('guide.writtenByLabel')}>
            <option value={agentType}>{agentName || t('guide.agentDefault')}</option>
            {dryRun && <option value={DRY_RUN_AGENT}>{t('guide.agentDry')}</option>}
          </select>
        </label>
        {mode === 'make' && (
          <label>
            {t('guide.sizeLabel')}{' '}
            <select value={size} onChange={(e) => setSize(e.target.value as GuideSize)} aria-label={t('guide.sizeLabel')}>
              {(['short', 'normal', 'deep'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(SIZE_KEYS[s])}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="ck-guide-actions">
        <button type="button" className="ck-btn ck-btn--plain" onClick={onCancel}>
          {t('guide.notNow')}
        </button>
        <button type="button" className="ck-btn ck-btn--primary" disabled={!estimate || busy} onClick={go}>
          {mode === 'refresh' ? t('guide.refreshButton') : t('guide.make')}
        </button>
      </div>
    </section>
  );
}
