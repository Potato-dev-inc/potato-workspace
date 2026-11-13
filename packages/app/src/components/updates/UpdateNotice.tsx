// A quiet notice in a corner: "Update available: 1.0.3" with an Update button. Nothing installs until the button is pressed.
// The file downloads first ("Downloading 42%"); if an agent is working then, the notice says which ones stop and asks:
// Restart now, or When agents finish. A failed update says why in a plain sentence and the app keeps running. If the agents
// were already stopped, it says so and offers to reopen the chats.
import { useT } from '../../i18n';
import type { AppUpdateState } from './useAppUpdate';
import { runningJobWarning } from '../../lib/app-update';
import '../../styles/app-update.css';

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
      {phase === 'downloading' && (
        <>
          <span>{state.percent === null ? t('overview.update.downloading') : t('overview.update.downloadingPercent', { percent: state.percent })}</span>
          {state.percent !== null && <progress className="app-update-bar" max={100} value={state.percent} aria-label={t('overview.update.progress')} />}
        </>
      )}
      {phase === 'ready' && (
        <>
          <span>{busy ? t('overview.update.ready', { warning: runningJobWarning(state.busyAgents, state.busy) }) : t('overview.update.readyRestart')}</span>
          <button type="button" className="app-update-btn" onClick={() => void state.restartNow()}>
            {t('overview.update.restartNow')}
          </button>
          {busy && (
            <button type="button" className="app-update-btn app-update-btn--quiet" onClick={state.restartWhenIdle}>
              {t('overview.update.whenAgentsFinish')}
            </button>
          )}
        </>
      )}
      {phase === 'waiting' && (
        <>
          <span>{t('overview.update.waiting')}</span>
          <button type="button" className="app-update-btn" onClick={() => void state.restartNow()}>
            {t('overview.update.restartNow')}
          </button>
        </>
      )}
      {phase === 'installing' && <span>{t('overview.update.installing')}</span>}
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
        <>
          <span>{state.error}</span>
          {offer && (
            <button type="button" className="app-update-btn" onClick={() => void state.update()}>
              {t('overview.update.tryAgain')}
            </button>
          )}
        </>
      )}
    </div>
  );
}
