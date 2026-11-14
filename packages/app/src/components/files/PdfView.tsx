// A PDF in WebView2's own viewer. That viewer refuses to start inside any sandboxed frame (checked in Edge: every
// `sandbox` setting shows a "blocked" page), so this frame is the one frame without the sandbox attribute. It is
// still closed in: it only ever loads a `blob:` address made here from the file's own bytes, typed as a PDF (never
// as a page), and only when the bytes start with the PDF marker. The viewer runs the PDF in its own isolated process.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';

/** `%PDF-` within the first kilobyte, as every real PDF has. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

export function PdfView({ bytes, name }: { bytes: Uint8Array; name: string }) {
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  const valid = looksLikePdf(bytes);
  useEffect(() => {
    if (!valid) return;
    const made = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [bytes, valid]);
  if (!valid) return <p className="ck-file-note" role="alert">{t('files.pdfFailed')}</p>;
  if (!url) return <p className="ck-file-note">{t('files.loading')}</p>;
  return (
    <div className="ck-pdf" data-testid="file-pdf">
      <iframe className="ck-sandbox ck-sandbox--fill" data-testid="pdf-frame" title={t('files.pdfLabel', { name })} src={url} referrerPolicy="no-referrer" />
    </div>
  );
}
