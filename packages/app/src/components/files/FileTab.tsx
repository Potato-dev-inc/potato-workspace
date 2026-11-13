// A file open beside the chat: read-only, with colour for code, Markdown as a page, pictures as pictures, and a clear
// message for files that are too big or not text. The File / Changes switch shows what the agent changed in the same
// place. Lines picked in either view can be sent to the chat box with "Tell the agent".
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { filesApi, fileSize, type FileContent, type FilesApi } from '../../lib/files-api';
import { pushComposerInsert } from '../../lib/composer-insert';
import { requestChatTab } from '../../lib/chatTab';
import { errorSentence } from '../../lib/sayError';
import { useT } from '../../i18n';
import { ChatMarkdown } from '../chat/ChatMarkdown';
import { SegTabs } from '../cockpit/SegTabs';
import { isMarkdown } from './languages';
import type { CodeSelection } from './CodeEditor';
import { FileDiff } from './FileDiff';
import { TellBar } from './TellBar';
import { tellText } from './tell-text';
import '../../styles/files.css';

// The editor is its own chunk: it loads when the first code file opens.
const CodeEditor = lazy(() => import('./CodeEditor').then((m) => ({ default: m.CodeEditor })));

type View = 'file' | 'changes';

export function FileTab({
  paneId,
  path,
  canTell,
  refreshKey = '',
  api = filesApi,
}: {
  paneId: string;
  path: string;
  /** The pane has a chat to tell (a plain shell has none). */
  canTell: boolean;
  /** Changes when the agent may have changed the file: it is read again. */
  refreshKey?: string;
  api?: FilesApi;
}) {
  const t = useT();
  const [view, setView] = useState<View>('file');
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [asText, setAsText] = useState(false);
  const [selection, setSelection] = useState<CodeSelection | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.read(paneId, path).then(
      (c) => {
        if (cancelled) return;
        setContent(c);
        setError(null);
      },
      (err: unknown) => !cancelled && setError(errorSentence(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [api, paneId, path, refreshKey]);

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

  const body = () => {
    if (view === 'changes') {
      if (patch === null) return <p className="ck-file-note">{t('files.loading')}</p>;
      return <FileDiff path={path} patch={patch} canTell={canTell} onTell={send} />;
    }
    if (error) {
      return (
        <p className="ck-file-note" role="alert">
          {error}
        </p>
      );
    }
    if (!content) return <p className="ck-file-note">{t('files.loading')}</p>;
    if (content.kind === 'too_large') {
      return (
        <p className="ck-file-note" data-testid="file-too-large">
          {t('files.tooLarge', { size: fileSize(content.size), limit: '2 MB' })}
        </p>
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
    if (isMarkdown(path) && !asText) {
      return (
        <div className="ck-file-page" data-testid="file-markdown">
          <ChatMarkdown text={text} />
        </div>
      );
    }
    return (
      <Suspense fallback={<p className="ck-file-note">{t('files.loading')}</p>}>
        <CodeEditor path={path} text={text} onSelect={setSelection} />
      </Suspense>
    );
  };

  const name = path.slice(path.lastIndexOf('/') + 1);
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return (
    <section className="ck-file" aria-label={t('files.fileLabel', { name })} data-testid="file-tab">
      <header className="ck-file-head">
        <span className="ck-file-name" title={path}>
          {name}
        </span>
        {folder && <span className="ck-file-folder">{folder}</span>}
        <span className="ck-head-gap" aria-hidden="true" />
        {isMarkdown(path) && view === 'file' && content?.kind === 'text' && (
          <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" aria-pressed={asText} onClick={() => setAsText((v) => !v)}>
            {asText ? t('files.showPage') : t('files.showText')}
          </button>
        )}
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
