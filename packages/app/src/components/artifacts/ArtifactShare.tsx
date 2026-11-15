// "Share" for a page: make a read-only link to ONE version that ends by itself (an hour, a day or a week), copy it, hand it
// to the system's share sheet when there is one, and stop it. The PC keeps only a hash of the link's secret, so the link is
// shown here once, when it is made.
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { SHARE_HOURS, type ArtifactShareMade, type ArtifactShareView, type ArtifactsApi } from '../../lib/artifacts';
import { errorSentence } from '../../lib/sayError';

const HOUR_KEY = { 1: 'artifacts.shareHour', 24: 'artifacts.shareDay', 168: 'artifacts.shareWeek' } as const;

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function ArtifactShare({ paneId, id, version, title, api, onClose }: { paneId: string; id: string; version: number; title: string; api: ArtifactsApi; onClose: () => void }) {
  const t = useT();
  const [hours, setHours] = useState<number>(24);
  const [made, setMade] = useState<ArtifactShareMade | null>(null);
  const [active, setActive] = useState<ArtifactShareView[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canSheet = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const refresh = useCallback(() => {
    api.shareList(paneId, id).then(setActive, () => undefined);
  }, [api, paneId, id]);
  useEffect(refresh, [refresh]);

  const make = () => {
    setBusy(true);
    setError(null);
    setNote(null);
    api.shareMake(paneId, id, version, hours).then(
      (m) => {
        setMade(m);
        setBusy(false);
        if (!m.link) setError(m.reason ?? t('artifacts.shareNoAddress'));
        refresh();
      },
      (err: unknown) => {
        setBusy(false);
        setError(errorSentence(err));
      },
    );
  };
  const copy = () => {
    if (!made?.link) return;
    const done = () => setNote(t('artifacts.shareCopied'));
    try {
      void navigator.clipboard.writeText(made.link).then(done, () => setError(t('artifacts.copyFailed')));
    } catch {
      setError(t('artifacts.copyFailed'));
    }
  };
  const sheet = () => {
    if (!made?.link) return;
    void navigator.share({ title, url: made.link }).catch(() => undefined);
  };
  const stop = () => {
    api.shareStop(paneId, id).then(
      () => {
        setMade(null);
        setActive([]);
        setNote(t('artifacts.shareStopped'));
      },
      (err: unknown) => setError(errorSentence(err)),
    );
  };

  const newest = active.length > 0 ? Math.max(...active.map((a) => a.expiresAt)) : 0;
  return (
    <div className="ck-art-share" role="group" aria-label={t('artifacts.shareTitle')} data-testid="artifact-share">
      <p className="ck-art-share-body">{t('artifacts.shareBody', { n: version })}</p>
      <div className="ck-art-share-row">
        <label className="ck-art-share-for">
          <span>{t('artifacts.shareFor')}</span>
          <select className="ck-art-select" value={hours} onChange={(e) => setHours(Number(e.target.value))} disabled={busy}>
            {SHARE_HOURS.map((h) => (
              <option key={h} value={h}>
                {t(HOUR_KEY[h])}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" onClick={make} disabled={busy}>
          {t('artifacts.shareMake')}
        </button>
        {active.length > 0 && (
          <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" onClick={stop}>
            {t('artifacts.shareStop')}
          </button>
        )}
        <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" onClick={onClose}>
          {t('artifacts.shareClose')}
        </button>
      </div>
      {made?.link && (
        <div className="ck-art-share-link">
          <input className="ck-art-share-input" readOnly value={made.link} aria-label={t('artifacts.shareCopy')} onFocus={(e) => e.currentTarget.select()} data-testid="artifact-share-link" />
          <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" onClick={copy}>
            {t('artifacts.shareCopy')}
          </button>
          {canSheet && (
            <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" onClick={sheet}>
              {t('artifacts.shareSheet')}
            </button>
          )}
          <span className="ck-art-share-meta">
            {t('artifacts.shareUntil', { when: when(made.expiresAt) })} {t('artifacts.shareOnce')}
          </span>
        </div>
      )}
      {!made && active.length > 0 && <p className="ck-art-share-meta">{t('artifacts.shareActive', { n: active.length, when: when(newest) })}</p>}
      {note && (
        <p className="ck-art-share-meta" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="ck-art-share-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
