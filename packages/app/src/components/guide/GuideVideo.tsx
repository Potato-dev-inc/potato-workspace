// The video tour card (plan section 12). Captions only, made on this PC from the guide: no agent, no usage, nothing
// uploaded. It has three faces: the question (what it is, how long, where it stays), the progress (with Stop), and the
// result (the files, or a plain note when only the captioned slideshow could be made). Nothing starts until "Make the tour".
import { useCallback, useEffect, useState } from 'react';
import { useT, getLanguage } from '../../i18n';
import { videoRunning, type GuideApi, type GuideVideoState } from '../../lib/guide';
import { errorSentence } from '../../lib/sayError';

export interface GuideVideoProps {
  paneId: string;
  api: GuideApi;
  project: string;
  pollMs?: number;
  onClose: () => void;
}

const FILE_LABEL: Record<string, 'guide.videoFileMp4' | 'guide.videoFileVertical' | 'guide.videoFileHtml'> = {
  'tour.mp4': 'guide.videoFileMp4',
  'tour-vertical.mp4': 'guide.videoFileVertical',
  'tour.html': 'guide.videoFileHtml',
};

export function GuideVideo({ paneId, api, project, pollMs = 1500, onClose }: GuideVideoProps) {
  const t = useT();
  const [view, setView] = useState<GuideVideoState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vertical, setVertical] = useState(false);
  const [busy, setBusy] = useState(false);
  // After "Make it again" the old result is hidden until the new run shows up.
  const [again, setAgain] = useState(false);

  const load = useCallback(() => {
    api.videoState(paneId).then(
      (v) => {
        setView(v);
        setError(null);
      },
      (err: unknown) => setError(errorSentence(err) || t('guide.loadFailed')),
    );
  }, [api, paneId, t]);

  useEffect(() => load(), [load]);
  const running = videoRunning(view);
  useEffect(() => {
    if (!running || pollMs <= 0) return;
    const timer = setInterval(load, pollMs);
    return () => clearInterval(timer);
  }, [running, pollMs, load]);

  const start = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api.videoStart(paneId, { vertical, language: getLanguage() }).then(
      () => {
        setBusy(false);
        setAgain(false);
        load();
      },
      (err: unknown) => {
        setBusy(false);
        setError(errorSentence(err));
      },
    );
  };

  const state = view?.state ?? null;
  const showResult = !!state && !running && !again && (state.phase === 'done' || state.phase === 'stopped' || state.phase === 'failed');

  let body;
  if (!view) {
    body = <p className="ck-file-note">{error ?? t('guide.loading')}</p>;
  } else if (running && state) {
    const pct = state.framesTotal > 0 ? Math.min(100, Math.round((state.framesDone / state.framesTotal) * 100)) : 0;
    body = (
      <>
        <h2 role="status">{state.phase === 'plan' ? t('guide.videoPlan') : t('guide.videoFrames')}</h2>
        <div className="ck-guide-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span style={{ width: `${pct}%` }} />
        </div>
        {state.framesTotal > 0 && <p className="ck-guide-fine">{t('guide.videoCount', { done: state.framesDone, total: state.framesTotal })}</p>}
        <div className="ck-guide-actions">
          <button type="button" className="ck-btn ck-btn--secondary" onClick={() => void api.videoStop(paneId).then(load, () => undefined)}>
            {t('guide.videoStop')}
          </button>
        </div>
      </>
    );
  } else if (showResult && state) {
    const title =
      state.phase === 'failed' ? t('guide.videoFailed') : state.phase === 'stopped' ? t('guide.videoStopped') : state.outcome === 'video' ? t('guide.videoDoneVideo') : t('guide.videoDoneSlideshow');
    body = (
      <>
        <h2 role="status">{title}</h2>
        {state.phase === 'done' && <p className="ck-guide-fine">{t('guide.videoSummary', { beats: state.beats, seconds: Math.round(state.seconds) })}</p>}
        {state.error && (
          <p className="ck-guide-fine" role="alert">
            {state.error}
          </p>
        )}
        {state.notes.map((n) => (
          <p key={n} className="ck-guide-fine">
            {n}
          </p>
        ))}
        {state.files.length > 0 && (
          <ul className="ck-guide-chips" aria-label={t('guide.videoLabel')}>
            {state.files.map((f) => {
              const key = FILE_LABEL[f.split('/').pop() ?? ''];
              return (
                <li key={f} className="ck-guide-chip" title={f}>
                  {key ? t(key) : f}
                </li>
              );
            })}
          </ul>
        )}
        {error && (
          <p className="ck-guide-fine" role="alert">
            {error}
          </p>
        )}
        <div className="ck-guide-actions">
          {state.files.length > 0 && (
            <button type="button" className="ck-btn ck-btn--secondary" onClick={() => void api.videoShow(paneId).catch((err: unknown) => setError(errorSentence(err)))}>
              {t('guide.videoShow')}
            </button>
          )}
          <button type="button" className="ck-btn ck-btn--secondary" onClick={() => setAgain(true)}>
            {t('guide.videoAgain')}
          </button>
          <button type="button" className="ck-btn ck-btn--primary" onClick={onClose}>
            {t('guide.videoClose')}
          </button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <h2>{t('guide.videoTitle', { project })}</h2>
        <p>{t('guide.videoIntro')}</p>
        <dl className="ck-guide-rows">
          <dt>{t('guide.videoRowLength')}</dt>
          <dd>{t('guide.videoRowLengthValue')}</dd>
          <dt>{t('guide.videoRowTime')}</dt>
          <dd>{t('guide.videoRowTimeValue')}</dd>
          <dt>{t('guide.videoRowUsage')}</dt>
          <dd>{t('guide.videoRowUsageValue')}</dd>
          <dt>{t('guide.videoRowStays')}</dt>
          <dd>{t('guide.videoRowStaysValue')}</dd>
        </dl>
        <label className="ck-guide-pick">
          <input type="checkbox" checked={vertical} onChange={(e) => setVertical(e.target.checked)} disabled={!view.canVideo} />
          <span>{t('guide.videoVertical')}</span>
        </label>
        {!view.canVideo && (
          <p className="ck-guide-note" data-testid="guide-video-notools">
            {t('guide.videoNoTools')}
          </p>
        )}
        {error && (
          <p className="ck-guide-fine" role="alert">
            {error}
          </p>
        )}
        <div className="ck-guide-actions">
          {view.files.length > 0 && (
            <button type="button" className="ck-btn ck-btn--plain" onClick={() => void api.videoShow(paneId).catch((err: unknown) => setError(errorSentence(err)))}>
              {t('guide.videoLast')}
            </button>
          )}
          <button type="button" className="ck-btn ck-btn--secondary" onClick={onClose}>
            {t('guide.videoNotNow')}
          </button>
          <button type="button" className="ck-btn ck-btn--primary" disabled={busy} onClick={start}>
            {t('guide.videoStart')}
          </button>
        </div>
      </>
    );
  }

  return (
    <section className="ck-guide-sheet" aria-label={t('guide.videoLabel')} data-testid="guide-video">
      {body}
    </section>
  );
}
