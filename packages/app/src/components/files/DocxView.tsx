// A Word file as a page. mammoth (the browser build) turns the document into HTML, the sanitiser keeps only page
// markup, and "Show text" swaps to the plain text. This file is its own chunk: it loads when a .docx is first opened.
import { useEffect, useState } from 'react';
import mammoth from 'mammoth/mammoth.browser';
import { useT } from '../../i18n';
import { sanitiseDocxHtml } from './sanitise-docx';

type Loaded = { html: string; text: string };

export function DocxView({ bytes, asText }: { bytes: Uint8Array; asText: boolean }) {
  const t = useT();
  const [doc, setDoc] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setFailed(false);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    Promise.all([mammoth.convertToHtml({ arrayBuffer: buffer }), mammoth.extractRawText({ arrayBuffer: buffer })]).then(
      ([html, raw]) => !cancelled && setDoc({ html: sanitiseDocxHtml(html.value), text: raw.value }),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  if (failed) return <p className="ck-file-note" role="alert">{t('files.docxFailed')}</p>;
  if (!doc) return <p className="ck-file-note">{t('files.loading')}</p>;
  if (asText) return <pre className="ck-file-plain" data-testid="file-docx-text">{doc.text}</pre>;
  return (
    <div
      className="ck-file-page ck-docx"
      data-testid="file-docx"
      // The HTML went through the sanitiser above; a click on a link in it never navigates the app.
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a')) e.preventDefault();
      }}
      dangerouslySetInnerHTML={{ __html: doc.html }}
    />
  );
}
