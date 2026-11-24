// A quiet notice, a bar under the page (a corner of the toast column in the simple view): "Update available: 1.0.3" with an Update button. Nothing installs until the button is pressed.
// The file downloads first ("Downloading 42%"); if an agent is working then, the notice says which ones stop and asks:
// Restart now, or When agents finish. A failed update says why in a plain sentence and the app keeps running. If the agents
// were already stopped, it says so and offers to reopen the chats.
import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLanguage, useT } from '../../i18n';
import { ErrorCard } from '../common/ErrorCard';
import type { AppUpdateState } from './useAppUpdate';
import { checkFailureLine, offerLine, runningJobWarning } from '../../lib/app-update';
import { downloadLine } from '../../lib/update-progress';
import { targetLabel } from '../../lib/update-schedule';
import '../../styles/app-update.css';

/** "Downloading 42%", the bar, and under it "58 MB of 138 MB · 3.1 MB/s · about 30 seconds left". Full: "Installing…". */
function DownloadingView({ state }: { state: AppUpdateState }) {
  const t = useT();
  const { percent, reading, stalled, step } = state;
  const full = reading !== null && reading.total !== null && reading.downloaded >= reading.total;
  if (full && step !== 'preparing') return <span>{t('overview.update.installingStep')}</span>;
  return (
    <>
      {step === 'preparing' && (
        <span className="app-update-detail" data-testid="update-step">
          {t('overview.update.preparing')}
        </span>
      )}
      {step === 'fallback' && (
        <span className="app-update-detail" data-testid="update-step">
          {t('overview.update.fallbackFull')}
        </span>
      )}
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

/** Notices the person closed, by phase and version, until the app restarts (in memory only: a newer version asks again). */
export const dismissedNotices = new Set<string>();
/** "Update available" closed for a version stays closed across launches (a newer version asks again). */
const DISMISSED_KEY = 'potato.update.dismissed';
try {
  for (const k of JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as string[]) dismissedNotices.add(k);
} catch {
  /* no storage: closed for this launch only */
}
function rememberDismissed() {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissedNotices].filter((k) => k.startsWith('available:'))));
  } catch {
    /* no storage */
  }
}
/** The phases that may be closed: a note about something, not a download or install that is running. */
const CLOSABLE = ['available', 'failed', 'error', 'stopped', 'ready'];
/** A failed check says so for a few seconds, then goes (the next check tries again anyway). */
const FAILED_SHOWS_MS = 8000;

/** `floating`: the notice sits over the corner of the app (not inside the Settings row). While it does, the page says so, (it lands in the in-flow slot at the bottom of the main column when there is one). */
export function UpdateNoticeView({ state, floating = true }: { state: AppUpdateState; floating?: boolean }) {
  const t = useT();
  const { phase, offer } = state;
  const [, again] = useState(0);
  const key = `${phase}:${offer?.version ?? ''}`;
  const closed = floating && dismissedNotices.has(key);
  const shown = !(phase === 'idle' || phase === 'none' || phase === 'checking') && !closed;
  const close = () => {
    dismissedNotices.add(key);
    rememberDismissed();
    again((n) => n + 1);
  };
  useEffect(() => {
    if (!floating || phase !== 'failed') return undefined;
    const id = window.setTimeout(close, FAILED_SHOWS_MS);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floating, phase, key]);
  // One column for every corner note: the notice goes into the toast column when there is one, so the two never overlap.
  const [column, setColumn] = useState<Element | null>(null);
  useLayoutEffect(() => setColumn(floating ? (document.querySelector('.ck-update-slot') ?? document.querySelector('.ck-toasts')) : null), [floating, shown]);
  useEffect(() => {
    if (!shown || !floating) return;
    const root = document.documentElement;
    root.setAttribute('data-update-notice', '');
    return () => root.removeAttribute('data-update-notice');
  }, [shown, floating]);
  if (!shown) return null;
  const busy = state.busyAgents.length > 0;
  const node = (
    <div className="app-update-notice" role="status" data-phase={phase}>
      {phase === 'available' && offer && (
        <>
          <span>{offerLine(offer)}</span>
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
      {floating && CLOSABLE.includes(phase) && (
        <button type="button" className="app-update-x" aria-label={t('overview.update.dismiss')} title={t('overview.update.dismiss')} onClick={close}>
          ×
        </button>
      )}
    </div>
  );
  return column ? createPortal(node, column) : node;
}
