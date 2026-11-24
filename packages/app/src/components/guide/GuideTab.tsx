// The Project guide, open beside the chat. Left: the pages (with marks for "out of date" and "needs review") and the
// diagram. Right: the page, drawn by the app's own Markdown renderer (no scripts); each citation is a numbered chip
// under the page that opens the file. With no guide it shows one card and a button; nothing starts by itself, and a run
// starts only from the consent card (`GuideSheet`).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { listen } from '../../lib/events';
import { useT } from '../../i18n';
import { ageWords, citationLabel, guideApi, isRunning, numberCitations, staleCount, type GuideApi, type GuideDiagram, type GuidePage, type GuideState } from '../../lib/guide';
import { openFileTab } from '../../lib/file-tabs';
import { errorSentence } from '../../lib/sayError';
import { ChatMarkdown } from '../chat/ChatMarkdown';
import { ArtifactBody } from '../artifacts/ArtifactBody';
import { GuideProgress } from './GuideProgress';
import { GuideSheet } from './GuideSheet';
import { GuideVideo } from './GuideVideo';
import '../../styles/files.css';
import '../../styles/guide.css';

const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const POLL_MS = 1500;
const DIAGRAM = 'diagram';

export interface GuideTabProps {
  paneId: string;
  api?: GuideApi;
  /** The project's folder name, for the title of the consent card. */
  project?: string;
  /** The agent this pane runs (the default writer). */
  agentType?: string;
  agentName?: string;
  /** Opens the consent card at once (the palette's "Make project guide"). */
  pollMs?: number;
}

export function GuideTab({ paneId, api = guideApi, project, agentType = '', agentName = '', pollMs = POLL_MS }: GuideTabProps) {
  const t = useT();
  const [state, setState] = useState<GuideState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'make' | 'refresh' | null>(null);
  const [view, setView] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [video, setVideo] = useState(false);

  const load = useCallback(() => {
    api.state(paneId).then(
      (s) => {
        setState(s);
        setError(null);
      },
      (err: unknown) => setError(errorSentence(err) || t('guide.loadFailed')),
    );
  }, [api, paneId, t]);

  useEffect(() => load(), [load]);

  // The PC says when a run ends or the guide changes; while a run goes we also ask now and then.
  useEffect(() => {
    if (!inTauri()) return;
    let off: (() => void) | undefined;
    let disposed = false;
    listen('guide://changed', () => load())
      .then((un) => (disposed ? un() : (off = un)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      off?.();
    };
  }, [load]);
  const running = isRunning(state?.run);
  useEffect(() => {
    if (!running || pollMs <= 0) return;
    const timer = setInterval(load, pollMs);
    return () => clearInterval(timer);
  }, [running, pollMs, load]);

  const structure = state?.structure ?? null;
  const firstPage = structure?.pages[0]?.id ?? null;
  const shown = view ?? firstPage;
  const projectName = project || t('guide.thisProject');

  let body;
  if (error && !state) {
    body = (
      <p className="ck-file-note" role="alert">
        {error}
      </p>
    );
  } else if (!state) {
    body = <p className="ck-file-note">{t('guide.loading')}</p>;
  } else if (!state.enabled) {
    body = <p className="ck-file-note">{t('guide.off')}</p>;
  } else if (state.run && running) {
    body = <GuideProgress paneId={paneId} api={api} run={state.run} />;
  } else if (video && state.hasGuide) {
    body = <GuideVideo paneId={paneId} api={api} project={projectName} pollMs={pollMs} onClose={() => setVideo(false)} />;
  } else if (sheet) {
    body = (
      <GuideSheet
        paneId={paneId}
        api={api}
        project={projectName}
        agentType={agentType}
        agentName={agentName}
        mode={sheet}
        dryRun={state.dryRun}
        onStarted={() => {
          setSheet(null);
          load();
        }}
        onCancel={() => setSheet(null)}
      />
    );
  } else if (!state.hasGuide || !structure) {
    body = (
      <>
        {state.last && state.last.phase !== 'done' && <GuideProgress paneId={paneId} api={api} run={state.last} />}
        <section className="ck-guide-card" data-testid="guide-empty">
          <h2>{t('guide.emptyTitle')}</h2>
          <p>{t('guide.emptyBody')}</p>
          <div className="ck-guide-actions">
            <button type="button" className="ck-btn ck-btn--primary" onClick={() => setSheet('make')}>
              {t('guide.emptyButton')}
            </button>
          </div>
        </section>
      </>
    );
  } else {
    const stale = staleCount(structure);
    body = (
      <>
        <header className="ck-guide-head">
          <span className="ck-guide-written" aria-label={t('guide.ageLabel')}>
            {structure.commit
              ? t('guide.writtenAt', { agent: structure.agent, age: ageWords(structure.writtenAtMs, Date.now(), t), commit: structure.commit })
              : t('guide.written', { agent: structure.agent, age: ageWords(structure.writtenAtMs, Date.now(), t) })}
          </span>
          <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" disabled={stale === 0} onClick={() => setSheet('refresh')}>
            {stale > 0 ? t('guide.refreshStale', { n: stale }) : t('guide.upToDate')}
          </button>
          <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" data-testid="guide-video-button" disabled={structure.pages.length === 0} onClick={() => setVideo(true)}>
            {t('guide.videoButton')}
          </button>
          <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
            {t('guide.more')}
          </button>
          {menu && (
            <button
              type="button"
              role="menuitem"
              className="ck-btn ck-btn--plain ck-btn--sm"
              onClick={() => {
                setMenu(false);
                if (window.confirm(t('guide.deleteAsk'))) void api.remove(paneId).then(() => { setView(null); load(); }, (err: unknown) => setError(errorSentence(err)));
              }}
            >
              {t('guide.delete')}
            </button>
          )}
        </header>
        {!structure.complete && <p className="ck-guide-note">{t('guide.incomplete')}</p>}
        <div className="ck-guide-main">
          <nav className="ck-guide-list" aria-label={t('guide.pages')}>
            {structure.pages.map((p) => (
              <button key={p.id} type="button" className={`ck-guide-item${shown === p.id ? ' is-active' : ''}`} aria-current={shown === p.id ? 'page' : undefined} onClick={() => setView(p.id)}>
                <span>{p.title}</span>
                {p.stale && <span className="ck-guide-mark ck-guide-mark--stale">{t('guide.stale')}</span>}
                {p.needsReview && <span className="ck-guide-mark">{t('guide.review')}</span>}
              </button>
            ))}
            {structure.diagram && (
              <button type="button" className={`ck-guide-item${shown === DIAGRAM ? ' is-active' : ''}`} aria-current={shown === DIAGRAM ? 'page' : undefined} onClick={() => setView(DIAGRAM)}>
                <span>{t('guide.diagram')}</span>
                {structure.diagramStale && <span className="ck-guide-mark ck-guide-mark--stale">{t('guide.stale')}</span>}
              </button>
            )}
          </nav>
          <div className="ck-guide-body">
            {shown === DIAGRAM ? <DiagramView paneId={paneId} api={api} onPage={setView} /> : shown ? <PageView key={shown} paneId={paneId} api={api} id={shown} /> : null}
          </div>
        </div>
      </>
    );
  }

  return (
    <section className="ck-guide ck-file" aria-label={t('guide.tabLabel')} data-testid="guide-tab">
      {body}
    </section>
  );
}

function PageView({ paneId, api, id }: { paneId: string; api: GuideApi; id: string }) {
  const t = useT();
  const [page, setPage] = useState<GuidePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.readPage(paneId, id).then(
      (p) => !cancelled && setPage(p),
      (err: unknown) => !cancelled && setError(errorSentence(err) || t('guide.loadFailed')),
    );
    return () => {
      cancelled = true;
    };
  }, [api, paneId, id, t]);
  const numbered = useMemo(() => (page ? numberCitations(page.markdown) : null), [page]);
  if (error) return <p className="ck-file-note" role="alert">{error}</p>;
  if (!page || !numbered) return <p className="ck-file-note">{t('guide.loading')}</p>;
  return (
    <article data-testid="guide-page">
      {page.stale && <p className="ck-guide-note">{t('guide.staleNote', { files: page.changed.join(', ') })}</p>}
      {page.needsReview && <p className="ck-guide-note">{t('guide.reviewNote')}</p>}
      <ChatMarkdown text={numbered.text} />
      {numbered.sources.length > 0 && (
        <div className="ck-guide-sources">
          <h3>{t('guide.sources')}</h3>
          <ul className="ck-guide-chips">
            {numbered.sources.map((s) => {
              const label = citationLabel(s);
              const changed = page.stale && page.changed.includes(s.path);
              return (
                <li key={s.n}>
                  <button
                    type="button"
                    className={`ck-guide-chip${changed ? ' is-changed' : ''}`}
                    title={changed ? t('guide.sourceChanged', { label }) : t('guide.sourceOpen', { label })}
                    aria-label={changed ? t('guide.sourceChanged', { label }) : t('guide.sourceOpen', { label })}
                    onClick={() => openFileTab(paneId, s.path)}
                  >
                    {s.n}. {label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </article>
  );
}

function DiagramView({ paneId, api, onPage }: { paneId: string; api: GuideApi; onPage: (id: string) => void }) {
  const t = useT();
  const [diagram, setDiagram] = useState<GuideDiagram | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.readDiagram(paneId).then(
      (d) => !cancelled && setDiagram(d),
      (err: unknown) => !cancelled && setError(errorSentence(err) || t('guide.loadFailed')),
    );
    return () => {
      cancelled = true;
    };
  }, [api, paneId, t]);
  if (error) return <p className="ck-file-note" role="alert">{error}</p>;
  if (!diagram) return <p className="ck-file-note">{t('guide.loading')}</p>;
  return (
    <div data-testid="guide-diagram">
      {diagram.stale && <p className="ck-guide-note">{t('guide.diagramStale')}</p>}
      <div className="ck-guide-diagram">
        <ArtifactBody kind="mermaid" content={diagram.mermaid} title={t('guide.diagramFrame')} />
      </div>
      <div className="ck-guide-parts">
        <h3>{t('guide.parts')}</h3>
        <ul className="ck-guide-chips">
          {diagram.boxes.map((b, i) => {
            const target = b.path ?? null;
            if (!target && !b.page) return null;
            return (
              <li key={`${b.label}-${i}`}>
                <button
                  type="button"
                  className="ck-guide-chip"
                  aria-label={target ? t('guide.partOpen', { label: b.label }) : t('guide.partPage', { label: b.label })}
                  onClick={() => (target ? openFileTab(paneId, target) : onPage(b.page!))}
                >
                  {b.label}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
