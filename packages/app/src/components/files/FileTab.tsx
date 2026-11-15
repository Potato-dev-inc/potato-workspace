// A file open beside the chat: colour for code, an Edit mode (Save with Ctrl+S, Revert, a notice when the file changed
// on disk), Markdown as a page, pictures as pictures, and a clear message for files that are too big or not text. The File / Changes switch shows what the agent changed in the same
// place. Lines picked in either view can be sent to the chat box with "Tell the agent".
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { filesApi, fileSize, type FileContent, type FilesApi, type FileStream } from '../../lib/files-api';
import { pushComposerInsert } from '../../lib/composer-insert';
import { requestChatTab } from '../../lib/chatTab';
import { errorSentence } from '../../lib/sayError';
import { useT } from '../../i18n';
import { ChatMarkdown } from '../chat/ChatMarkdown';
import { SegTabs } from '../cockpit/SegTabs';
import { PaneMoreMenu, type MoreAction } from '../cockpit/PaneMoreMenu';
import { useHeadFold } from '../cockpit/usePaneHeadFold';
import { extensionOf, isMarkdown } from './languages';
import { stripHtmlComments } from '../../lib/markdownComments';
import { opensInOwnApp, richKindOf, type RichKind } from './rich-kind';
import type { CodeGoTo, CodeSelection } from './CodeEditor';
import { FileActions } from './FileActions';
import { FileDiff } from './FileDiff';
import { useOpenInEditor } from './OpenInEditor';
import type { EditorApi } from '../../lib/my-editor';
import { ConflictBar } from './ConflictBar';
import { TellBar } from './TellBar';
import { useFileEdit } from './useFileEdit';
import { isDirty, useDraftKeys } from '../../lib/file-drafts';
import { tellText } from './tell-text';
import { lazyViewer, ViewerBoundary } from './lazy-viewer';
import '../../styles/files.css';

// The code view and the code editor are their own chunks: the view loads when the first code file opens, the editor
// when a person starts editing.
const CodeEditor = lazyViewer(() => import('./CodeEditor').then((m) => m.CodeEditor));
const CodeEdit = lazyViewer(() => import('./CodeEdit').then((m) => m.CodeEdit));

// Each viewer is its own chunk: it loads when the first file of its kind opens, never with the app.
const DocxView = lazyViewer(() => import('./DocxView').then((m) => m.DocxView));
const SheetView = lazyViewer(() => import('./SheetView').then((m) => m.SheetView));
const PdfView = lazyViewer(() => import('./PdfView').then((m) => m.PdfView));
const HtmlView = lazyViewer(() => import('./HtmlView').then((m) => m.HtmlView));

type View = 'file' | 'changes';

/** The viewers that need the file's raw bytes (the rest read text or a picture). */
const needsBytes = (kind: RichKind | null) => kind === 'docx' || kind === 'pdf' || kind === 'sheet';

export function FileTab({
  paneId,
  path,
  canTell,
  refreshKey = '',
  api = filesApi,
  editor,
  goTo,
}: {
  paneId: string;
  path: string;
  /** The pane has a chat to tell (a plain shell has none). */
  canTell: boolean;
  /** Changes when the agent may have changed the file: it is read again. */
  refreshKey?: string;
  api?: FilesApi;
  /** The editor calls (a test double can stand in). */
  editor?: EditorApi;
  /** Show this line (a hit of "Search inside files"): a page view switches to the text so the line is there. */
  goTo?: CodeGoTo;
}) {
  const t = useT();
  const opener = useOpenInEditor(paneId, editor);
  const [view, setView] = useState<View>('file');
  const rich = richKindOf(path);
  const [content, setContent] = useState<FileContent | null>(null);
  const [file, setFile] = useState<FileStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [asText, setAsText] = useState(false);
  const [selection, setSelection] = useState<CodeSelection | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const openOwnApp = useCallback(
    () => void api.openDefault(paneId, path).then(() => setNotice(null), (err: unknown) => setNotice(errorSentence(err))),
    [api, paneId, path],
  );
  const edit = useFileEdit({ api, paneId, path, content, setContent, onNotice: setNotice });
  const unsaved = isDirty(useDraftKeys(), paneId, path);
  useEffect(() => {
    if (goTo && (isMarkdown(path) || rich === 'html')) setAsText(true);
  }, [goTo, path, rich]);
  const canEdit = view === 'file' && !rich && content?.kind === 'text' && !error;
  // A narrow header folds its right-side buttons (Open in …, Show text) into one "…" menu instead of cutting them off.
  const headRef = useRef<HTMLElement>(null);
  const fold = useHeadFold(headRef, `${view}|${edit.editing}|${rich}|${unsaved}|${path}|${content?.kind}`);

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    if (needsBytes(richKindOf(path))) {
      api.openBytes(paneId, path).then(
        (b) => {
          if (cancelled) return;
          setFile(b);
          setError(null);
        },
        (err: unknown) => !cancelled && setError(errorSentence(err)),
      );
    } else {
      api.read(paneId, path).then(
        (c) => {
          if (cancelled) return;
          setContent(c);
          setError(null);
        },
        (err: unknown) => !cancelled && setError(errorSentence(err)),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [api, paneId, path, refreshKey]);

  // The way out of a file that cannot be shown: its own program, or the folder.
  const openApp = useCallback(() => {
    void api.openDefault(paneId, path).then(() => setNotice(null), (err: unknown) => setNotice(errorSentence(err)));
  }, [api, paneId, path]);
  const reveal = useCallback(() => {
    void api.reveal(paneId, path).then(() => setNotice(null), (err: unknown) => setNotice(errorSentence(err)));
  }, [api, paneId, path]);
  const openLabel = rich === 'docx' ? t('files.openWord') : rich === 'sheet' ? t('files.openExcel') : t('files.openDefault');
  const actions = <FileActions openLabel={openLabel} onOpen={rich ? openApp : undefined} onReveal={reveal} />;

  useEffect(() => {
    if (view !== 'changes') return;
    let cancelled = false;
    api.diff(paneId, path).then(
      (p) => !cancelled && setPatch(p),
      (err: unknown) => {
        if (cancelled) return;
        setPatch('');
        setError(errorSentence(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, paneId, path, view, refreshKey]);

  const send = useCallback(
    (text: string) => {
      pushComposerInsert(paneId, text);
      requestChatTab(paneId);
      setNotice(t('files.tellDone'));
    },
    [paneId, t],
  );

  // Open in my editor: the header button, and Ctrl+Enter (at the first picked line, else the top).
  const openEditor = useCallback(
    (line?: number) => {
      void opener.open(path, line).then((problem) => setNotice(problem));
    },
    [opener, path],
  );

  const body = () => {
    if (view === 'changes') {
      if (patch === null) return <p className="ck-file-note">{t('files.loading')}</p>;
      return <FileDiff path={path} patch={patch} canTell={canTell} onTell={send} onOpenAt={openEditor} />;
    }
    if (error) {
      return (
        <p className="ck-file-note" role="alert">
          {error}
        </p>
      );
    }
    if (needsBytes(rich)) {
      if (!file) return <p className="ck-file-note">{t('files.loading')}</p>;
      if (file.kind === 'too_large' || !file.source) {
        return (
          <>
            <p className="ck-file-note" data-testid="file-too-large">
              {t('files.tooLarge', { size: fileSize(file.size), limit: `${Math.round(file.limit / (1024 * 1024))} MB` })}
            </p>
            {actions}
          </>
        );
      }
      const name = file.name;
      return (
        <ViewerBoundary resetKey={path} onOpen={openOwnApp}><Suspense fallback={<p className="ck-file-note">{t('files.loading')}</p>}>
          {rich === 'docx' && <DocxView source={file.source} asText={asText} actions={actions} />}
          {rich === 'pdf' && <PdfView source={file.source} name={name} actions={actions} />}
          {rich === 'sheet' && <SheetView source={file.source} csv={extensionOf(path) === 'csv'} actions={actions} />}
        </Suspense></ViewerBoundary>
      );
    }
    if (!content) return <p className="ck-file-note">{t('files.loading')}</p>;
    if (content.kind === 'too_large') {
      return (
        <>
          <p className="ck-file-note" data-testid="file-too-large">
            {t('files.tooLarge', { size: fileSize(content.size), limit: '2 MB' })}
          </p>
          <FileActions onOpen={opensInOwnApp(path) ? openApp : undefined} onReveal={reveal} />
        </>
      );
    }
    if (content.kind === 'binary') return <p className="ck-file-note">{t('files.binary')}</p>;
    if (content.kind === 'image' && content.dataUrl) {
      return (
        <div className="ck-file-image" data-testid="file-image">
          <img src={content.dataUrl} alt={content.name} />
        </div>
      );
    }
    const text = content.text ?? '';
    if (edit.editing && !rich) {
      return (
        <ViewerBoundary resetKey={path} onOpen={openOwnApp}><Suspense fallback={<p className="ck-file-note">{t('files.loading')}</p>}>
          <CodeEdit path={path} initial={edit.initial} revision={edit.revision} onChange={edit.onChange} onSave={edit.save} onSelect={setSelection} />
        </Suspense></ViewerBoundary>
      );
    }
    if (rich === 'html' && !asText) {
      return (
        <ViewerBoundary resetKey={path} onOpen={openOwnApp}><Suspense fallback={<p className="ck-file-note">{t('files.loading')}</p>}>
          <HtmlView html={text} name={content.name} />
        </Suspense></ViewerBoundary>
      );
    }
    if (isMarkdown(path) && !asText) {
      return (
        <div className="ck-file-page" data-testid="file-markdown">
          <ChatMarkdown text={stripHtmlComments(text)} />
        </div>
      );
    }
    return (
      <ViewerBoundary resetKey={path} onOpen={openOwnApp}><Suspense fallback={<p className="ck-file-note">{t('files.loading')}</p>}>
        <CodeEditor path={path} text={text} onSelect={setSelection} goTo={goTo} />
      </Suspense></ViewerBoundary>
    );
  };

  const showTextToggle = view === 'file' && !edit.editing && ((isMarkdown(path) || rich === 'html') && content?.kind === 'text' ? true : rich === 'docx' && file?.kind === 'stream');
  const moreActions: MoreAction[] = [];
  if (rich) moreActions.push({ id: 'open-app', label: openLabel, onSelect: openApp });
  if (!rich || rich === 'html' || extensionOf(path) === 'csv') {
    moreActions.push({
      id: 'open-editor',
      label: opener.name ? t('editor.open', { name: opener.name }) : t('editor.openGeneric'),
      title: opener.none ? t('editor.none') : undefined,
      disabled: opener.none,
      onSelect: () => openEditor(selection?.from),
    });
  }
  if (showTextToggle) moreActions.push({ id: 'as-text', label: asText ? t('files.showPage') : t('files.showText'), onSelect: () => setAsText((v) => !v) });
  const name = path.slice(path.lastIndexOf('/') + 1);
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return (
    <section
      className="ck-file"
      aria-label={t('files.fileLabel', { name })}
      data-testid="file-tab"
      onKeyDown={(e) => {
        if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey) && !e.defaultPrevented && edit.editing) {
          e.preventDefault();
          edit.save();
          return;
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.defaultPrevented && view === 'file') {
          e.preventDefault();
          openEditor(selection?.from);
        }
      }}
    >
      <header className="ck-file-head" ref={headRef} data-fold={fold}>
        <span className="ck-file-name" title={path}>
          {name}
        </span>
        {unsaved && <span className="ck-file-dot" role="img" aria-label={t('files.unsaved')} title={t('files.unsaved')} />}
        {folder && <span className="ck-file-folder">{folder}</span>}
        <span className="ck-head-gap" aria-hidden="true" />
        {canEdit && edit.editing && (
          <>
            <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" disabled={!edit.dirty && !edit.conflict} onClick={edit.revert}>
              {t('files.revert')}
            </button>
            <button type="button" className="ck-btn ck-btn--primary ck-btn--sm" disabled={!edit.dirty || edit.saving} onClick={edit.save}>
              {t('files.save')}
            </button>
          </>
        )}
        {canEdit && (
          <button
            type="button"
            className="ck-btn ck-btn--plain ck-btn--sm"
            aria-pressed={edit.editing}
            disabled={edit.editing && edit.dirty}
            title={edit.editing && edit.dirty ? t('files.doneBlocked') : undefined}
            onClick={edit.editing ? edit.stop : edit.start}
          >
            {edit.editing ? t('files.editDone') : t('files.edit')}
          </button>
        )}
        {rich && fold < 1 && (
          <button
            type="button"
            className="ck-btn ck-btn--plain ck-btn--sm"
            onClick={openApp}
          >
            {openLabel}
          </button>
        )}
        {(!rich || rich === 'html' || extensionOf(path) === 'csv') && fold < 1 && (
        <button
          type="button"
          className="ck-btn ck-btn--plain ck-btn--sm"
          disabled={opener.none}
          title={opener.none ? t('editor.none') : undefined}
          onClick={() => openEditor(selection?.from)}
        >
          {opener.name ? t('editor.open', { name: opener.name }) : t('editor.openGeneric')}
        </button>
        )}
        {showTextToggle && fold < 1 && (
          <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" aria-pressed={asText} onClick={() => setAsText((v) => !v)}>
            {asText ? t('files.showPage') : t('files.showText')}
          </button>
        )}
        {fold >= 1 && moreActions.length > 0 && <PaneMoreMenu label={t('files.moreActions')} items={[]} actions={moreActions} value="" onPick={() => undefined} />}
        <SegTabs<View>
          small
          label={t('files.viewLabel')}
          value={view}
          onChange={(v) => {
            setView(v);
            setSelection(null);
            setNotice(null);
          }}
          options={[
            { id: 'file', label: t('files.viewFile') },
            { id: 'changes', label: t('files.viewChanges') },
          ]}
        />
      </header>
      {edit.editing && edit.conflict && view === 'file' && <ConflictBar onReload={edit.reload} onKeepMine={edit.keepMine} busy={edit.saving} />}
      <div className="ck-file-body">{body()}</div>
      {view === 'file' && canTell && selection && (
        <TellBar
          count={selection.to - selection.from + 1}
          onClear={() => setSelection(null)}
          onTell={(note) => {
            send(tellText(path, selection.from, selection.to, selection.text, note));
            setSelection(null);
          }}
        />
      )}
      {notice && (
        <p className="ck-file-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
