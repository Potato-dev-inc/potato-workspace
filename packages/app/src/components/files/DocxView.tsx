// A Word file as a page. mammoth (the browser build) runs in a worker (see `office-client.ts`) and turns the document
// into HTML with the pictures left out as placeholders; the text shows at once and each picture loads when it scrolls
// near, drawn at a smaller size. The sanitiser keeps only page markup, and "Show text" swaps to the plain text.
// A document with more than DOCX_BLOCK_CAP blocks shows its first part, and one that takes too long shows a way out
// ("Open in Word") instead of an error. This file is its own chunk: it loads when a .docx is first opened.
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useT } from '../../i18n';
import type { FileSource } from '../../lib/files-api';
import { IMAGE_ID_PREFIX } from './docx-engine';
import { openDocx, type DocxSession } from './office-client';
import { DOCX_BLOCK_CAP, sanitiseDocxPage } from './sanitise-docx';

/** After this long without a page the file counts as too heavy to show here. */
export const DOCX_HEAVY_MS = 120_000;

type Phase = { state: 'loading' } | { state: 'failed' } | { state: 'heavy' } | { state: 'ready'; html: string; styled: boolean; truncated: boolean; timing: string };

export function DocxView({ source, asText, actions }: { source: FileSource; asText: boolean; actions: ReactNode }) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>({ state: 'loading' });
  const [text, setText] = useState<string | null>(null);
  const session = useRef<DocxSession | null>(null);
  const page = useRef<HTMLDivElement | null>(null);
  const desk = useRef<HTMLDivElement | null>(null);
  const [zoomMode, setZoomMode] = useState<'fit' | 'full'>('fit');
  const [scale, setScale] = useState(1);

  useEffect(() => {
    let cancelled = false;
    setPhase({ state: 'loading' });
    setText(null);
    const opened = openDocx(source);
    session.current = opened;
    const timer = setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      opened.close();
      setPhase({ state: 'heavy' });
    }, DOCX_HEAVY_MS);
    opened.opened.then(
      ({ html, styled, openMs }) => {
        if (cancelled) return;
        clearTimeout(timer);
        setPhase({ state: 'ready', styled, ...sanitiseDocxPage(html, DOCX_BLOCK_CAP), timing: openMs === undefined ? '' : `${openMs} ms in the worker` });
      },
      () => {
        if (cancelled) return;
        clearTimeout(timer);
        setPhase({ state: 'failed' });
      },
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
      opened.close();
      session.current = null;
    };
  }, [source]);

  const ready = phase.state === 'ready';
  useEffect(() => {
    if (!asText || !ready || text !== null) return;
    let cancelled = false;
    session.current?.text().then((v) => !cancelled && setText(v), () => !cancelled && setText(''));
    return () => {
      cancelled = true;
    };
  }, [asText, ready, text]);

  // Zoom: "fit" shrinks the pages to the width of the pane (never bigger than they are); "100%" shows them as they are.
  const styled = phase.state === 'ready' && phase.styled;
  useEffect(() => {
    const box = desk.current;
    if (!styled || !box) return;
    const measure = () => {
      const sheet = page.current?.querySelector<HTMLElement>('.ck-wp-sheet');
      const wide = parseFloat(sheet?.style.width ?? '');
      const room = box.clientWidth - 32;
      setScale(zoomMode === 'fit' && wide > 0 && room > 0 ? Math.min(1, Math.max(0.25, room / wide)) : 1);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const watcher = new ResizeObserver(measure);
    watcher.observe(box);
    return () => watcher.disconnect();
  }, [styled, zoomMode, phase]);

  // Pictures: each loads when it is near the screen (all at once where the page cannot tell, as in tests).
  const html = phase.state === 'ready' ? phase.html : '';
  useEffect(() => {
    const root = page.current;
    const open = session.current;
    if (!root || !open || asText || !html) return;
    const urls: string[] = [];
    let alive = true;
    const load = (img: HTMLImageElement) => {
      const index = Number(img.id.slice(IMAGE_ID_PREFIX.length));
      open.picture(index).then(
        (blob) => {
          if (!alive) return;
          if (!blob || typeof URL.createObjectURL !== 'function') return void img.classList.add('is-missing');
          const url = URL.createObjectURL(blob);
          urls.push(url);
          img.src = url;
          img.classList.add('is-loaded');
        },
        () => alive && img.classList.add('is-missing'),
      );
    };
    const pictures = Array.from(root.querySelectorAll<HTMLImageElement>(`img[id^="${IMAGE_ID_PREFIX}"]`));
    let watcher: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === 'function') {
      watcher = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            watcher?.unobserve(entry.target);
            load(entry.target as HTMLImageElement);
          }
        },
        { rootMargin: '900px 0px' },
      );
      for (const img of pictures) watcher.observe(img);
    } else {
      for (const img of pictures) load(img);
    }
    return () => {
      alive = false;
      watcher?.disconnect();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [html, asText]);

  if (phase.state === 'failed') {
    return (
      <>
        <p className="ck-file-note" role="alert">{t('files.docxFailed')}</p>
        {actions}
      </>
    );
  }
  if (phase.state === 'heavy') {
    return (
      <>
        <p className="ck-file-note" role="alert" data-testid="file-docx-heavy">{t('files.docxHeavy')}</p>
        {actions}
      </>
    );
  }
  if (phase.state === 'loading') return <p className="ck-file-note">{t('files.loading')}</p>;
  if (asText) {
    if (text === null) return <p className="ck-file-note">{t('files.loading')}</p>;
    return <pre className="ck-file-plain" data-testid="file-docx-text">{text}</pre>;
  }
  const note = phase.truncated && (
    <div className="ck-file-actions--top" data-testid="file-docx-truncated">
      <span className="ck-file-note" style={{ padding: 0 }}>{t('files.docxCut')}</span>
      {actions}
    </div>
  );
  // The click handler: the HTML went through the sanitiser above; a click on a link in it never navigates the app.
  const stop = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('a')) e.preventDefault();
  };
  if (phase.styled) {
    return (
      <div className="ck-wp-view">
        {note}
        <div className="ck-wp-bar" role="group" aria-label={t('files.zoomLabel')}>
          {(['fit', 'full'] as const).map((m) => (
            <button key={m} type="button" className={`ck-wp-zoom${zoomMode === m ? ' is-active' : ''}`} aria-pressed={zoomMode === m} onClick={() => setZoomMode(m)}>
              {t(m === 'fit' ? 'files.zoomFit' : 'files.zoom100')}
            </button>
          ))}
        </div>
        <div ref={desk} className="ck-wp-desk">
          <div
            ref={page}
            className="ck-wp-pages"
            data-testid="file-docx"
            data-open-timing={phase.timing}
            data-zoom={scale.toFixed(2)}
            style={{ zoom: scale }}
            onClick={stop}
            dangerouslySetInnerHTML={{ __html: phase.html }}
          />
        </div>
      </div>
    );
  }
  return (
    <>
      {note}
      <div
        ref={page}
        className="ck-file-page ck-docx"
        data-testid="file-docx"
        data-open-timing={phase.timing}
        onClick={stop}
        dangerouslySetInnerHTML={{ __html: phase.html }}
      />
    </>
  );
}
