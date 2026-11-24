// A page the agent made, open beside the chat (in the side pane, in a tab or in a window of its own). The page is drawn
// in the locked frame (see `ArtifactBody`). Above it: the title, a version picker, Point, Share, Open in browser, Copy file
// path and Reload (and, in the side pane, Open in a window, Full width and Close). While it is open it asks now and then
// whether the agent made a newer version, and says so with a "Show it" button; nothing jumps under the reader.
//
// Mark up (Labs `markup_bar_enabled`): a floating bar over the page (Select, Pen, Shape, Text, Colour, Undo, Clear, Send). It
// is Point and Fix with drawing: Select is the old Point picker, and what is marked goes to the chat as one picture and a
// numbered list (`components/markup/`). "Open in" chooses where the page lives: beside the chat, its own window, or the
// agent browser. With the switch off, Point works as it always did.
//
// Point: the next click in the page is a pick; the person says what should change and it goes to the chat that made the
// page (`paneId`), as a message in that chat. Share: a read-only link to this version (`ArtifactShare`).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../../i18n';
import { useHost } from '../../lib/host/context';
import { artifactsApiFor, opensInBrowser, type ArtifactPage, type ArtifactsApi } from '../../lib/artifacts';
import { takeArtifactPoint } from '../../lib/artifact-side';
import { noteArtifactTitle } from '../../lib/artifact-tabs';
import { canPoint, composeArtifactPointMessage, MAX_PICK_REQUEST, pickLabel, type ArtifactPick } from '../../lib/artifact-point';
import { sendPaneMessage } from '../../lib/paneOutbox';
import { errorSentence } from '../../lib/sayError';
import { ArtifactBody, type BodyMarkup } from './ArtifactBody';
import { ArtifactShare } from './ArtifactShare';
import { OpenInMenu } from './OpenInMenu';
import { MarkupHost } from '../markup/MarkupHost';
import { markupApi, type MarkupApi } from '../../lib/markup/api';
import { useMarkupEnabled } from '../../lib/markup/labs';
import '../../styles/files.css';
import '../../styles/artifacts.css';

const POLL_MS = 4000;

/** What the side pane adds to the toolbar (the tab and the window have none of it). */
export interface SideChrome {
  full: boolean;
  onFull: () => void;
  onPopOut: () => void;
  onClose: () => void;
}

export function ArtifactTab({
  paneId,
  id,
  api: given,
  pollMs = POLL_MS,
  side,
  send = sendPaneMessage,
  markupOn,
  markup = markupApi,
}: {
  paneId: string;
  id: string;
  api?: ArtifactsApi;
  pollMs?: number;
  side?: SideChrome;
  /** Puts a message into a chat (a test double can stand in). */
  send?: (paneId: string, text: string) => Promise<unknown>;
  /** The mark-up bar is on (the Labs switch). Left out, the switch is read. */
  markupOn?: boolean;
  /** The picture and the send of the mark-up bar (a test double can stand in). */
  markup?: MarkupApi;
}) {
  const t = useT();
  const host = useHost();
  const api = useMemo(() => given ?? artifactsApiFor(host), [given, host]);
  const labsOn = useMarkupEnabled();
  const bar = markupOn ?? labsOn;
  const [markOpen, setMarkOpen] = useState(false);
  const [page, setPage] = useState<ArtifactPage | null>(null);
  /** The version the person picked; null follows the newest one at the time of loading. */
  const [picked, setPicked] = useState<number | null>(null);
  const [newest, setNewest] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [picking, setPicking] = useState(false);
  const [pick, setPick] = useState<ArtifactPick | null>(null);
  const [request, setRequest] = useState('');
  const [sending, setSending] = useState(false);
  const [sharing, setSharing] = useState(false);

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
  const pointable = !!page && canPoint(page.artifact.kind);

  // "Try it" on Point and fix opens the page already waiting for a click.
  useEffect(() => {
    if (side && pointable && takeArtifactPoint(paneId)) {
      if (bar) setMarkOpen(true);
      else setPicking(true);
    }
  }, [side, pointable, paneId, bar]);

  const onPick = useCallback((p: ArtifactPick) => {
    setPicking(false);
    setPick(p);
  }, []);
  const stopPointing = () => {
    setPicking(false);
    setPick(null);
    setRequest('');
  };
  const togglePoint = () => {
    if (picking) {
      stopPointing();
      return;
    }
    setPick(null);
    setSharing(false);
    setPicking(true);
  };
  const toggleShare = () => {
    stopPointing();
    setSharing((v) => !v);
  };
  const sendPoint = () => {
    if (!page || !pick || sending) return;
    let text: string;
    try {
      text = composeArtifactPointMessage({ title, id, version: page.version, pick, request });
    } catch (err) {
      setNotice(errorSentence(err));
      return;
    }
    setSending(true);
    send(paneId, text).then(
      () => {
        setSending(false);
        stopPointing();
        setNotice(t('artifacts.pointSent'));
      },
      (err: unknown) => {
        setSending(false);
        setNotice(errorSentence(err));
      },
    );
  };

  const body = (bridge?: BodyMarkup) => (
    <div className="ck-art-body">
      {error ? (
        <p className="ck-file-note" role="alert">
          {error}
        </p>
      ) : !page ? (
        <p className="ck-file-note">{t('artifacts.loading')}</p>
      ) : (
        <ArtifactBody
          key={`${page.version}:${reloads}`}
          kind={page.artifact.kind}
          content={page.content}
          title={title}
          picking={!bridge && picking}
          onPick={!bridge && pointable ? onPick : undefined}
          markup={bridge}
        />
      )}
    </div>
  );

  return (
    <section
      className="ck-art ck-file"
      aria-label={side ? t('artifacts.sideLabel', { title }) : t('artifacts.tabLabel', { title })}
      data-testid={side ? 'artifact-side-view' : 'artifact-tab'}
    >
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
        {page && bar && (
          <button
            type="button"
            className={`ck-btn ck-btn--plain ck-btn--sm${markOpen ? ' is-on' : ''}`}
            aria-pressed={markOpen}
            title={t('markup.openTip')}
            onClick={() => setMarkOpen((v) => !v)}
            data-testid="artifact-point"
          >
            {t('markup.open')}
          </button>
        )}
        {page && bar && (
          <OpenInMenu
            beside={!!side}
            onWindow={side ? side.onPopOut : undefined}
            onBrowser={() =>
              void api.openInAgentBrowser(paneId, id).then(
                () => {
                  setNotice(null);
                  side?.onClose();
                },
                (err: unknown) => setNotice(errorSentence(err) || t('markup.openIn.failed')),
              )
            }
          />
        )}
        {page && !bar && (
          <button
            type="button"
            className={`ck-btn ck-btn--plain ck-btn--sm${picking ? ' is-on' : ''}`}
            aria-pressed={picking}
            disabled={!pointable}
            title={pointable ? undefined : t('artifacts.pointSvg')}
            onClick={togglePoint}
            data-testid="artifact-point"
          >
            {picking ? t('artifacts.pointStop') : t('artifacts.point')}
          </button>
        )}
        {page && (
          <button type="button" className={`ck-btn ck-btn--plain ck-btn--sm${sharing ? ' is-on' : ''}`} aria-expanded={sharing} onClick={toggleShare} data-testid="artifact-share-open">
            {t('artifacts.share')}
          </button>
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
        {side && (
          <>
            {!bar && (
              <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" onClick={side.onPopOut} data-testid="artifact-popout">
                {t('artifacts.popOut')}
              </button>
            )}
            <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" aria-pressed={side.full} onClick={side.onFull} data-testid="artifact-full">
              {side.full ? t('artifacts.backToChat') : t('artifacts.full')}
            </button>
            <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" onClick={side.onClose} data-testid="artifact-close">
              {t('artifacts.close')}
            </button>
          </>
        )}
      </header>
      {sharing && page && <ArtifactShare paneId={paneId} id={id} version={page.version} title={title} api={api} onClose={() => setSharing(false)} />}
      {picking && (
        <p className="ck-art-hint" role="status" data-testid="artifact-point-hint">
          {t('artifacts.pointHint')}
        </p>
      )}
      {pick && (
        <div className="ck-art-point" data-testid="artifact-point-box">
          <p className="ck-art-point-what">{t('artifacts.pointedAt', { what: pickLabel(pick) })}</p>
          <textarea
            className="ck-art-point-input"
            rows={2}
            maxLength={MAX_PICK_REQUEST}
            value={request}
            placeholder={t('artifacts.pointPlaceholder')}
            aria-label={t('artifacts.pointRequest')}
            onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                sendPoint();
              } else if (e.key === 'Escape') stopPointing();
            }}
          />
          <div className="ck-art-point-row">
            <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" disabled={sending || request.trim() === ''} onClick={sendPoint} data-testid="artifact-point-send">
              {t('artifacts.pointSend')}
            </button>
            <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" onClick={stopPointing}>
              {t('artifacts.pointCancel')}
            </button>
          </div>
        </div>
      )}
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
      {bar ? (
        <MarkupHost open={markOpen} onOpenChange={setMarkOpen} paneId={paneId} title={title} id={id} version={page?.version ?? 0} selectDisabled={!pointable} api={markup}>
          {body}
        </MarkupHost>
      ) : (
        body()
      )}
    </section>
  );
}
