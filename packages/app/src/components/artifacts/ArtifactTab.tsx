// A page the agent made, open beside the chat. The page is drawn in the locked frame (see `ArtifactBody`). Above it: the
// title, a version picker, Open in browser, Copy file path and Reload. While the tab is open it asks now and then
// whether the agent made a newer version, and says so with a "Show it" button; nothing jumps under the reader.
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { artifactsApi, opensInBrowser, type ArtifactPage, type ArtifactsApi } from '../../lib/artifacts';
import { noteArtifactTitle } from '../../lib/artifact-tabs';
import { errorSentence } from '../../lib/sayError';
import { ArtifactBody } from './ArtifactBody';
import '../../styles/files.css';
import '../../styles/artifacts.css';

const POLL_MS = 4000;

export function ArtifactTab({ paneId, id, api = artifactsApi, pollMs = POLL_MS }: { paneId: string; id: string; api?: ArtifactsApi; pollMs?: number }) {
  const t = useT();
  const [page, setPage] = useState<ArtifactPage | null>(null);
  /** The version the person picked; null follows the newest one at the time of loading. */
  const [picked, setPicked] = useState<number | null>(null);
  const [newest, setNewest] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.read(paneId, id, picked ?? undefined).then(
      (p) => {
        if (cancelled) return;
        setPage(p);
        setNewest(p.artifact.versions[p.artifact.versions.length - 1]?.n ?? p.version);
        noteArtifactTitle(id, p.artifact.title);
        setError(null);
      },
      (err: unknown) => !cancelled && setError(errorSentence(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [api, paneId, id, picked, reloads]);

  // Is there a newer version? (`sync` also turns pages dropped into the folder into cards.)
  useEffect(() => {
    if (pollMs <= 0) return;
    let live = true;
    const timer = setInterval(() => {
      api.sync(paneId).then(
        (list) => {
          const mine = list.find((a) => a.id === id);
          if (live && mine) setNewest(mine.versions[mine.versions.length - 1]?.n ?? 0);
        },
        () => undefined,
      );
    }, pollMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, paneId, id, pollMs]);

  const showNewest = useCallback(() => {
    setPicked(null);
    setReloads((n) => n + 1);
    setNotice(null);
  }, []);

  const copyPath = useCallback(() => {
    if (!page) return;
    const done = () => setNotice(t('artifacts.pathCopied'));
    const failed = () => setNotice(t('artifacts.copyFailed'));
    try {
      void navigator.clipboard.writeText(page.path).then(done, failed);
    } catch {
      failed();
    }
  }, [page, t]);

  const title = page?.artifact.title ?? id;
  const kind = page?.artifact.kind;
  return (
    <section className="ck-art ck-file" aria-label={t('artifacts.tabLabel', { title })} data-testid="artifact-tab">
      <header className="ck-art-head">
        <span className="ck-art-title" title={title}>
          {title}
        </span>
        <span className="ck-head-gap" aria-hidden="true" />
        {page && page.artifact.versions.length > 1 && (
          <select
            className="ck-art-select"
            aria-label={t('artifacts.versionLabel')}
            value={page.version}
            onChange={(e) => setPicked(Number(e.target.value))}
          >
            {[...page.artifact.versions].reverse().map((v) => (
              <option key={v.n} value={v.n}>
                {v.n === newest ? t('artifacts.versionLatest', { n: v.n }) : t('artifacts.versionOption', { n: v.n })}
              </option>
            ))}
          </select>
        )}
        {page && kind && opensInBrowser(kind) && (
          <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" onClick={() => void api.openInBrowser(paneId, id, page.version).then(() => setNotice(null), (err: unknown) => setNotice(errorSentence(err)))}>
            {t('artifacts.openBrowser')}
          </button>
        )}
        {page && (
          <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" onClick={copyPath}>
            {t('artifacts.copyPath')}
          </button>
        )}
        <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" onClick={showNewest}>
          {t('artifacts.reload')}
        </button>
      </header>
      {page && newest > page.version && (
        <div className="ck-art-newer" role="status" data-testid="artifact-newer">
          <span>{t('artifacts.newer')}</span>
          <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" onClick={showNewest}>
            {t('artifacts.showNewest')}
          </button>
        </div>
      )}
      {notice && (
        <p className="ck-file-note" role="status">
          {notice}
        </p>
      )}
      <div className="ck-art-body">
        {error ? (
          <p className="ck-file-note" role="alert">
            {error}
          </p>
        ) : !page ? (
          <p className="ck-file-note">{t('artifacts.loading')}</p>
        ) : (
          <ArtifactBody key={`${page.version}:${reloads}`} kind={page.artifact.kind} content={page.content} title={title} />
        )}
      </div>
    </section>
  );
}
