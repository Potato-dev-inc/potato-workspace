// A PDF in WebView2's own viewer. That viewer refuses to start inside any sandboxed frame (checked in Edge: every
// `sandbox` setting shows a "blocked" page), so this frame is the one frame without the sandbox attribute. It is
// still closed in: it only ever loads an address made here for the file (the app's own `pmfile` stream, or a `blob:`
// made from bytes in hand), typed as a PDF (never as a page), and only when the file starts with the PDF marker.
// The viewer streams the file by ranges, so a 300 MB PDF is not read whole into the app. The viewer runs the PDF in
// its own isolated process.
import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import { bytesOfSource, type FileSource } from '../../lib/files-api';

// The marker is decoded from base64 on purpose (a literal, or char codes, get folded back into one by the minifier). Tauri serves each asset with a type it guesses from the file's
// first 1024 bytes, and anything holding the text "%PDF" there is sent as application/pdf. A literal marker in this
// chunk's first lines made the app refuse to load the chunk as a script ("Failed to fetch dynamically imported
// module"). scripts/check-lazy-chunks.mjs fails the build if any chunk would be sniffed that way.
const PDF_MARKER = atob('JVBERi0=');

/** The PDF marker within the first kilobyte, as every real PDF has. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes(PDF_MARKER);
}

type State = { state: 'loading' } | { state: 'bad' } | { state: 'ready'; url: string };

export function PdfView({ source, name, actions }: { source: FileSource; name: string; actions?: ReactNode }) {
  const t = useT();
  const [view, setView] = useState<State>({ state: 'loading' });
  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    setView({ state: 'loading' });
    // Only the first kilobyte is read to check the marker; the viewer asks for the rest itself.
    bytesOfSource(source, 'bytes=0-1023').then(
      (head) => {
        if (cancelled) return;
        const bytes = new Uint8Array(head).subarray(0, 1024);
        if (!looksLikePdf(bytes)) return setView({ state: 'bad' });
        if ('url' in source) return setView({ state: 'ready', url: source.url });
        made = URL.createObjectURL(new Blob([source.bytes as BlobPart], { type: 'application/pdf' }));
        setView({ state: 'ready', url: made });
      },
      () => !cancelled && setView({ state: 'bad' }),
    );
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [source]);
  if (view.state === 'bad') {
    return (
      <>
        <p className="ck-file-note" role="alert">{t('files.pdfFailed')}</p>
        {actions}
      </>
    );
  }
  if (view.state === 'loading') return <p className="ck-file-note">{t('files.loading')}</p>;
  return (
    <div className="ck-pdf" data-testid="file-pdf">
      <iframe className="ck-sandbox ck-sandbox--fill" data-testid="pdf-frame" title={t('files.pdfLabel', { name })} src={view.url} referrerPolicy="no-referrer" />
    </div>
  );
}
