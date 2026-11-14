// "Review the last turn" file by file: each file the turn changed gets Keep and Put back. Put back returns only that
// file to how it was before the turn and shows the undo bar. J and K move, A keeps, X puts back, T writes about the
// file in the message box, V marks it looked at; a diff scrolled to its end counts as looked at too. "Changed since you
// looked" shows when the agent edited a file again after it was ticked. Everything reads the turn's save points, so it
// works in any folder, with or without Git, for every agent.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '../../../i18n';
import { requestChatTab } from '../../../lib/chatTab';
import { pushComposerInsert } from '../../../lib/composer-insert';
import { markStep } from '../../../lib/getting-started';
import { editorApi, type EditorApi } from '../../../lib/my-editor';
import { errorSentence } from '../../../lib/sayError';
import {
  clearDecision,
  countsFor,
  keepFile,
  lookedAt,
  putBackMark,
  stateOf,
  turnReviewApi,
  useReviewMarks,
  useTurnReview,
  type ReviewFile,
  type TurnReviewApi,
  type TurnReviewData,
} from '../../../lib/turn-review';
import { showUndo } from '../../../lib/undo-bar';
import { FileDiff } from '../../files/FileDiff';
import { useOpenInEditor } from '../../files/OpenInEditor';
import { splitPath } from '../changes-rows';
import '../../../styles/cockpit-turnfiles.css';

const EDITABLE = /^(INPUT|TEXTAREA|SELECT)$/;

/** The text of the counter line: "6 kept · 1 put back · 2 left" (a part with none is left out). */
export function counterParts(t: ReturnType<typeof useT>, c: { kept: number; back: number; left: number }): string {
  const parts: string[] = [];
  if (c.kept > 0) parts.push(t('review.keptCount', { count: c.kept }));
  if (c.back > 0) parts.push(t('review.backCount', { count: c.back }));
  if (c.left > 0 || parts.length === 0) parts.push(t('review.leftCount', { count: c.left }));
  return parts.join(' · ');
}

export function TurnFiles({
  paneId,
  status,
  api = turnReviewApi,
  editor = editorApi,
}: {
  paneId: string;
  /** The pane's status: a change reads the turn again, and `running` turns Put back off. */
  status: string;
  api?: TurnReviewApi;
  editor?: EditorApi;
}) {
  const t = useT();
  const { load, reload } = useTurnReview(paneId, status, api);
  useReviewMarks();
  const opener = useOpenInEditor(paneId, editor);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [patches, setPatches] = useState<Record<string, string | null>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const running = status === 'running';
  const review: TurnReviewData | null = load.state === 'ready' ? load.review : null;
  const files = review?.files ?? [];

  // A new turn is a new list: forget the open diff and the cursor.
  const turnKey = review ? `${review.afterId}` : '';
  useEffect(() => {
    setOpen(null);
    setPatches({});
    setActive(0);
  }, [turnKey, paneId]);

  const focusRow = (path: string) => {
    window.requestAnimationFrame(() => {
      const rows = rootRef.current?.querySelectorAll<HTMLElement>('[data-tf-row]') ?? [];
      [...rows].find((el) => el.dataset.tfRow === path)?.focus();
    });
  };

  const showDiff = (f: ReviewFile) => {
    if (!review || patches[f.path] !== undefined) return;
    if (f.binary || f.status === 'D') {
      setPatches((cur) => ({ ...cur, [f.path]: '' }));
      return;
    }
    setPatches((cur) => ({ ...cur, [f.path]: null }));
    api.patch(paneId, review.beforeId, review.afterId, f.path).then(
      (text) => setPatches((cur) => ({ ...cur, [f.path]: text })),
      (err: unknown) => {
        setPatches((cur) => ({ ...cur, [f.path]: '' }));
        setNotice(errorSentence(err));
      },
    );
  };

  const toggle = (f: ReviewFile) => {
    if (open === f.path) return setOpen(null);
    setOpen(f.path);
    showDiff(f);
    // Nothing to scroll in a deleted or binary file: opening it is looking at it.
    if (f.binary || f.status === 'D') lookedAt(paneId, f);
  };

  const keep = (f: ReviewFile) => {
    markStep('review');
    keepFile(paneId, f);
    setNotice(null);
  };

  const bringBack = useCallback(
    async (f: ReviewFile, safetyId: string | null) => {
      if (!review || !safetyId) return clearDecision(paneId, f.path);
      await api.putBack(paneId, safetyId, f.path);
      clearDecision(paneId, f.path);
      reload();
    },
    [api, paneId, reload, review],
  );

  const putBack = async (f: ReviewFile) => {
    if (!review || running) return;
    const name = splitPath(f.path).name;
    try {
      const report = await api.putBack(paneId, review.beforeId, f.path);
      markStep('review');
      putBackMark(paneId, f, report.safetyId);
      setNotice(null);
      const text =
        report.action === 'removed' ? t('review.putBackRemoved', { name }) : report.action === 'nothing' ? t('review.putBackNothing', { name }) : t('review.putBackDone', { name });
      showUndo({
        text,
        undo: report.action === 'nothing' ? undefined : () => bringBack(f, report.safetyId),
        failText: t('undo.failed'),
      });
      reload();
    } catch (err) {
      setNotice(t('review.putBackFailed', { name, reason: errorSentence(err) }));
    }
  };

  const tell = (f: ReviewFile) => {
    pushComposerInsert(paneId, t('review.tellText', { path: f.path }));
    requestChatTab(paneId);
  };

  const openEditor = async (path: string, line?: number) => {
    const problem = await opener.open(path, line);
    setNotice(problem);
  };

  const step = (by: number, then?: (f: ReviewFile) => void) => {
    if (files.length === 0) return;
    const next = Math.max(0, Math.min(files.length - 1, active + by));
    setActive(next);
    focusRow(files[next].path);
    then?.(files[next]);
  };

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (target && (EDITABLE.test(target.tagName) || target.isContentEditable)) return;
    const f = files[active];
    if (!f) return;
    const key = e.key.toLowerCase();
    if (key === 'j') step(1);
    else if (key === 'k') step(-1);
    else if (key === 'a') {
      keep(f);
      step(1);
    } else if (key === 'x') {
      void putBack(f);
      step(1);
    } else if (key === 't') tell(f);
    else if (key === 'v') lookedAt(paneId, f);
    else if (key === 'o') void openEditor(f.path);
    else return;
    e.preventDefault();
  };

  if (load.state === 'loading') {
    return (
      <section className="ck-tf" aria-label={t('review.title')} data-testid="turn-files">
        <p className="ck-sub ck-pad">{t('review.loading')}</p>
      </section>
    );
  }
  if (load.state === 'error') {
    return (
      <section className="ck-tf" aria-label={t('review.title')} data-testid="turn-files">
        <h3 className="ck-caption">{t('review.title')}</h3>
        <p className="ck-sub" role="status">
          {load.message}
        </p>
      </section>
    );
  }
  if (!review) {
    return (
      <section className="ck-tf" aria-label={t('review.title')} data-testid="turn-files">
        <h3 className="ck-caption">{t('review.title')}</h3>
        <p className="ck-sub">{t('review.none')}</p>
      </section>
    );
  }

  const counts = countsFor(paneId, files);
  return (
    <section className="ck-tf" aria-label={t('review.title')} data-testid="turn-files" ref={rootRef} onKeyDown={onKey}>
      <header className="ck-tf-head">
        <h3 className="ck-caption">{t('review.title')}</h3>
        <span className="ck-tf-counter" role="status" aria-live="polite" data-testid="turn-files-counter">
          {counterParts(t, counts)}
        </span>
        <span className="ck-tf-looked" data-testid="turn-files-looked">
          {t('review.lookedCount', { done: counts.looked, total: counts.total })}
        </span>
      </header>
      <p className="ck-sub ck-tf-keys">{t('review.keys')}</p>
      <ul className="ck-tf-list" aria-label={t('review.filesLabel')}>
        {files.map((f, i) => {
          const s = stateOf(paneId, f);
          const { dir, name } = splitPath(f.path);
          const isOpen = open === f.path;
          const patch = patches[f.path];
          return (
            <li key={f.path} className="ck-tf-item" data-decision={s.decision ?? 'left'} data-look={s.look} data-testid="turn-file">
              <div className={`ck-tf-row${i === active ? ' is-active' : ''}`}>
                <button
                  type="button"
                  className="ck-tf-main"
                  data-tf-row={f.path}
                  tabIndex={i === active ? 0 : -1}
                  aria-expanded={isOpen}
                  aria-label={t(isOpen ? 'review.hide' : 'review.show', { name })}
                  title={f.path}
                  onFocus={() => setActive(i)}
                  onClick={() => toggle(f)}
                >
                  <span className={`ck-tf-mark ck-tf-mark--${f.status}`} aria-hidden="true">
                    {f.status === 'A' ? '+' : f.status === 'D' ? '−' : '~'}
                  </span>
                  <span className="ck-tf-path">
                    {dir && <span className="ck-tf-dir">{dir}</span>}
                    <span className="ck-tf-name">{name}</span>
                  </span>
                  <span className="ck-tf-counts">
                    {f.binary ? (
                      t('review.binary')
                    ) : (
                      <>
                        {(f.added > 0 || f.deleted === 0) && <span className="ck-add">+{f.added}</span>}
                        {f.added > 0 && f.deleted > 0 && ' '}
                        {f.deleted > 0 && <span className="ck-del">−{f.deleted}</span>}
                      </>
                    )}
                  </span>
                  {s.decision === 'kept' && <span className="ck-tf-badge">{t('review.stateKept')}</span>}
                  {s.decision === 'back' && <span className="ck-tf-badge">{t('review.stateBack')}</span>}
                  {s.look === 'looked' && !s.decision && <span className="ck-tf-badge ck-tf-badge--quiet">{t('review.stateLooked')}</span>}
                  {s.look === 'changed' && <span className="ck-tf-badge ck-tf-badge--warn">{t('review.changedSince')}</span>}
                </button>
                <span className="ck-tf-actions">
                  <button type="button" className="ck-btn ck-btn--sm ck-btn--secondary" aria-pressed={s.decision === 'kept'} title={t('review.keepTip')} onClick={() => keep(f)}>
                    {t('review.keep')}
                  </button>
                  {s.decision === 'back' ? (
                    <button type="button" className="ck-btn ck-btn--sm ck-btn--secondary" disabled={running} onClick={() => void bringBack(f, s.safetyId).catch((err: unknown) => setNotice(errorSentence(err)))}>
                      {t('common.undo')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="ck-btn ck-btn--sm ck-btn--secondary"
                      disabled={running}
                      title={running ? t('review.workingWhy') : t('review.putBackTip')}
                      onClick={() => void putBack(f)}
                    >
                      {t('review.putBack')}
                    </button>
                  )}
                  <button type="button" className="ck-btn ck-btn--sm ck-btn--plain" title={t('review.tellTip')} onClick={() => tell(f)}>
                    {t('review.tell')}
                  </button>
                  {f.status !== 'D' && (
                    <button
                      type="button"
                      className="ck-btn ck-btn--sm ck-btn--plain"
                      disabled={opener.none}
                      title={opener.none ? t('editor.none') : undefined}
                      onClick={() => void openEditor(f.path)}
                    >
                      {opener.name ? t('editor.open', { name: opener.name }) : t('editor.openGeneric')}
                    </button>
                  )}
                </span>
              </div>
              {isOpen && (
                <div className="ck-tf-diff">
                  {patch === undefined || patch === null ? (
                    <p className="ck-file-note">{t('review.diffLoading')}</p>
                  ) : patch === '' ? (
                    <p className="ck-file-note">{t('review.noChanges')}</p>
                  ) : (
                    <FileDiff
                      path={f.path}
                      patch={patch}
                      canTell={false}
                      onTell={() => undefined}
                      onOpenAt={(line) => void openEditor(f.path, line)}
                      onEnd={() => lookedAt(paneId, f)}
                    />
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {review.truncated && <p className="ck-sub">{t('review.truncated', { count: files.length })}</p>}
      {notice && (
        <p className="ck-sub ck-tf-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
