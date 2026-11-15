// A picture the agent named in its answer (`![chart](out/chart.png)`). The picture is asked of the PC, which only reads a file
// inside the chat's project folder and sends it back as a data URL (a web address is never loaded, an svg never runs). The page
// offers the PC through `PictureSourceContext`; with none (an old chat with no pane behind it) only the words are shown.
// A click opens a large view that closes with Esc, a click, or the Close button.
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n';
import type { LoadedPicture, PictureSource } from '../../lib/chatMore';
import { errorSentence } from '../../lib/sayError';
import '../../styles/chat-picture.css';

export const PictureSourceContext = createContext<PictureSource | null>(null);

/** Pictures kept after they were read, so a re-drawn answer does not ask again. A few only: each can be several MB. */
const KEEP = 8;
const cache = new Map<string, Promise<LoadedPicture>>();

/** For tests: forget what was kept. */
export function clearPictureCache(): void {
  cache.clear();
}

function loadOnce(source: PictureSource, path: string): Promise<LoadedPicture> {
  const key = `${source.key}\n${path}`;
  const kept = cache.get(key);
  if (kept) {
    cache.delete(key);
    cache.set(key, kept);
    return kept;
  }
  const promise = source.load(path);
  cache.set(key, promise);
  // A refusal is not kept: the file may appear a moment later (the agent wrote it after naming it).
  promise.catch(() => {
    if (cache.get(key) === promise) cache.delete(key);
  });
  while (cache.size > KEEP) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return promise;
}

type Shown = { state: 'loading' } | { state: 'ready'; picture: LoadedPicture } | { state: 'refused'; reason: string };

/** `PICTURE_NOT_IN_PROJECT: That picture ...` becomes the sentence alone. */
function sentence(error: unknown): string {
  return errorSentence(error).replace(/^PICTURE_[A-Z_]+:\s*/, '');
}

export function ChatPicture({ alt, path }: { alt: string; path: string }) {
  const t = useT();
  const source = useContext(PictureSourceContext);
  const [shown, setShown] = useState<Shown>({ state: 'loading' });
  const [big, setBig] = useState(false);

  useEffect(() => {
    if (!source) return;
    let live = true;
    setShown({ state: 'loading' });
    loadOnce(source, path).then(
      (picture) => live && setShown({ state: 'ready', picture }),
      (error: unknown) => live && setShown({ state: 'refused', reason: sentence(error) }),
    );
    return () => {
      live = false;
    };
  }, [source, path]);

  if (!source) return <span className="ck-chat-pic-alt">{alt ? `[${alt}]` : t('chat.picture.alt')}</span>;
  if (shown.state === 'loading') return <span className="ck-chat-pic-note" role="status">{t('chat.picture.loading')}</span>;
  if (shown.state === 'refused') {
    return (
      <span className="ck-chat-pic-note is-refused" data-testid="chat-picture-refused" title={path}>
        {t('chat.picture.refused', { reason: shown.reason })}
      </span>
    );
  }
  const label = alt || shown.picture.name;
  return (
    <>
      <button type="button" className="ck-chat-pic" data-testid="chat-picture" aria-label={t('chat.picture.enlarge', { name: label })} onClick={() => setBig(true)}>
        <img src={shown.picture.dataUrl} alt={label} draggable={false} />
      </button>
      {big && <Enlarged picture={shown.picture} label={label} onClose={() => setBig(false)} />}
    </>
  );
}

/** The large view: over everything, closes on Esc, on a click anywhere or on Close. */
function Enlarged({ picture, label, onClose }: { picture: LoadedPicture; label: string; onClose: () => void }) {
  const t = useT();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="ck-chat-pic-big" role="dialog" aria-modal="true" aria-label={label} data-testid="chat-picture-big" onClick={onClose}>
      <img src={picture.dataUrl} alt={label} draggable={false} />
      <button ref={closeRef} type="button" className="ck-chat-pic-close" onClick={onClose}>
        {t('chat.picture.close')}
      </button>
    </div>,
    document.body,
  );
}
