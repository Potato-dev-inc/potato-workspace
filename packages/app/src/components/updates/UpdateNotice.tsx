// A quiet notice in a corner: "Update available: 1.0.3" with an Update button. Nothing installs until the button is pressed.
// The file downloads first ("Downloading 42%"); if an agent is working then, the notice says which ones stop and asks:
// Restart now, or When agents finish. A failed update says why in a plain sentence and the app keeps running. If the agents
// were already stopped, it says so and offers to reopen the chats.
import { useLanguage, useT } from '../../i18n';
import { ErrorCard } from '../common/ErrorCard';
import type { AppUpdateState } from './useAppUpdate';
import { checkFailureLine, runningJobWarning } from '../../lib/app-update';
import { downloadLine } from '../../lib/update-progress';
import { targetLabel } from '../../lib/update-schedule';
import '../../styles/app-update.css';

/** "Downloading 42%", the bar, and under it "58 MB of 138 MB · 3.1 MB/s · about 30 seconds left". Full: "Installing…". */
function DownloadingView({ state }: { state: AppUpdateState }) {
  const t = useT();
  const { percent, reading, stalled } = state;
  const full = reading !== null && reading.total !== null && reading.downloaded >= reading.total;
  if (full) return <span>{t('overview.update.installingStep')}</span>;
  return (
    <>
      <span>{percent === null ? t('overview.update.downloading') : t('overview.update.downloadingPercent', { percent })}</span>
      {percent !== null && <progress className="app-update-bar" max={100} value={percent} aria-label={t('overview.update.progress')} />}
      {reading && (
        <span className="app-update-detail" data-testid="update-detail">
          {downloadLine(reading)}
        </span>
      )}
      {stalled && (
        <span className="app-update-detail" role="alert">
          {t('overview.update.stalled')}
        </span>
      )}
    </>
  );
}

/** Ready while agents are working: they are never stopped by default. Three plain choices; the chosen one is pressed. */
function UpdateChoice({ state }: { state: AppUpdateState }) {
  const t = useT();
  const { phase, when, target, offer } = state;
  const count = state.busyAgents.length;
  const lang = useLanguage();
  const tonight = target !== null ? targetLabel(target, lang) : null;
  const waiting = phase === 'waiting';
  return (
    <div className="app-update-choice" role="group" aria-label={t('flow.update.groupLabel')}>
      <span className="app-update-line">
        <strong>{offer ? t('flow.update.readyVersion', { version: offer.version }) : t('flow.update.ready')}</strong>
        {count > 0 && <> {t('flow.update.working', { count })} {t('flow.update.notStopped')}</>}
      </span>
      {waiting && when === 'finish' && <span className="app-update-detail">{t('flow.update.waitingFinish')}</span>}
      {waiting && when === 'tonight' && tonight && <span className="app-update-detail">{t('flow.update.waitingTonight', { time: tonight })}</span>}
      <span className="app-update-choices">
        <button type="button" className="app-update-btn" aria-pressed={waiting && when === 'finish'} onClick={state.restartWhenIdle}>
          {t('flow.update.whenFinish')}
        </button>
        <button type="button" className="app-update-btn" aria-pressed={waiting && when === 'tonight'} onClick={state.restartTonight}>
          {t('flow.update.tonight')}
        </button>
        <button
          type="button"
          className="app-update-btn app-update-btn--quiet"
          title={runningJobWarning(state.busyAgents, state.busy)}
          onClick={() => void state.restartNow()}
        >
          {t('flow.update.now')}
        </button>
      </span>
    </div>
  );
}

export function UpdateNoticeView({ state }: { state: AppUpdateState }) {
  const t = useT();
  const { phase, offer } = state;
  if (phase === 'idle' || phase === 'none' || phase === 'checking') return null;
  const busy = state.busyAgents.length > 0;
  return (
    <div className="app-update-notice" role="status" data-phase={phase}>
      {phase === 'available' && offer && (
        <>
          <span>{t('overview.update.available', { version: offer.version })}</span>
          <button type="button" className="app-update-btn" onClick={() => void state.update()}>
            {t('overview.update.update')}
          </button>
        </>
      )}
      {phase === 'downloading' && <DownloadingView state={state} />}
      {phase === 'ready' && !busy && (
        <>
          <span>{t('overview.update.readyRestart')}</span>
          <button type="button" className="app-update-btn" onClick={() => void state.restartNow()}>
            {t('overview.update.restartNow')}
          </button>
        </>
      )}
      {((phase === 'ready' && busy) || phase === 'waiting') && <UpdateChoice state={state} />}
      {phase === 'installing' && (
        <span>
          <strong>{t('overview.update.installingStep')}</strong> {t('overview.update.installing')}
        </span>
      )}
      {phase === 'failed' && state.failure && <span>{checkFailureLine(state.failure)}</span>}
      {phase === 'stopped' && (
        <>
          <span>{state.reopened ? t('overview.update.reopened') : t('overview.update.stopped', { why: state.error ?? t('overview.update.agentsStopped') })}</span>
          {!state.reopened && (
            <button type="button" className="app-update-btn" onClick={() => void state.reopenChats()}>
              {t('overview.update.reopenChats')}
            </button>
          )}
          {offer && (
            <button type="button" className="app-update-btn app-update-btn--quiet" onClick={() => void state.update()}>
              {t('overview.update.tryAgain')}
            </button>
          )}
        </>
      )}
      {phase === 'error' && (
        <ErrorCard
          compact
          testId="update-error"
          what={state.error ?? t('overview.update.fallback')}
          can={t('flow.error.updateFailed.can')}
          action={offer ? { label: t('overview.update.tryAgain'), onClick: () => void state.update() } : undefined}
        />
      )}
    </div>
  );
}
