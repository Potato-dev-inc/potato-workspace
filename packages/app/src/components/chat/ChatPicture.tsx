// A picture the agent named in its answer (`![chart](out/chart.png)`). The picture is asked of the PC, which only reads a file
// inside the chat's project folder and sends it back as a data URL (a web address is never loaded, an svg never runs). The page
// offers the PC through `PictureSourceContext`; with none (an old chat with no pane behind it) only the words are shown.
// A click opens the large view (ImageLightbox); the pictures of the same answer are its Previous / Next.
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import type { LoadedPicture, PictureSource } from '../../lib/chatMore';
import { errorSentence } from '../../lib/sayError';
import { ImageLightbox, type LightboxImage } from '../common/ImageLightbox';
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
  const [big, setBig] = useState<{ images: LightboxImage[]; index: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);

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
      <button ref={button} type="button" className="ck-chat-pic" data-testid="chat-picture" aria-label={t('chat.picture.enlarge', { name: label })} onClick={() => setBig(gather(button.current, shown.picture, label))}>
        <img src={shown.picture.dataUrl} alt={label} draggable={false} />
      </button>
      {big && <ImageLightbox images={big.images} index={big.index} onIndex={(index) => setBig({ images: big.images, index })} onClose={() => setBig(null)} testId="chat-picture-big" />}
    </>
  );
}

/** The pictures of the same answer (the ones drawn inside the same `.ck-chat-md`), in order, with the clicked one's place. */
function gather(button: HTMLButtonElement | null, picture: LoadedPicture, label: string): { images: LightboxImage[]; index: number } {
  const own: LightboxImage = { key: '0', name: label, src: picture.dataUrl };
  const group = button?.closest('.ck-chat-md');
  if (!button || !group) return { images: [own], index: 0 };
  const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>('[data-testid="chat-picture"]'));
  const images = buttons.flatMap((b, i) => {
    const img = b.querySelector('img');
    return img?.getAttribute('src') ? [{ key: String(i), name: img.getAttribute('alt') || label, src: img.getAttribute('src') }] : [];
  });
  const index = buttons.filter((b) => b.querySelector('img')?.getAttribute('src')).indexOf(button);
  return index >= 0 ? { images, index } : { images: [own], index: 0 };
}
