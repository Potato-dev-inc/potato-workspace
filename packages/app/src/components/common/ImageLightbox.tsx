// The large view of a picture: a dim full-window backdrop, the picture centred at its own shape and sized to fit the window
// (never cropped), a Close button at the top right, and Previous / Next with "1 of 2" at the bottom when there are several.
// Closes on Escape, on a press outside the picture and its buttons, and on Close. Left and Right move between pictures.
// Focus goes to Close when it opens, stays inside while it is open, and goes back to what had it. It draws into the app's
// top layer like the other layers (see Floating), so it covers the whole window and the chat never shows through.
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n';
import { useDismissable } from '../../hooks/useDismissable';
import '../../styles/image-lightbox.css';

export interface LightboxImage {
  key: string;
  name: string;
  /** The picture as a data URL, or null while it is still being read. */
  src: string | null;
}

export interface ImageLightboxProps {
  images: readonly LightboxImage[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  /** Test id of the backdrop (the dialog). */
  testId?: string;
}

function Icon({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function ImageLightbox({ images, index, onIndex, onClose, testId = 'image-lightbox' }: ImageLightboxProps) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const total = images.length;
  const at = Math.min(Math.max(index, 0), Math.max(total - 1, 0));
  const current = images[at];
  const many = total > 1;

  // Focus: in on open, back to where it was on close.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => before?.focus?.();
  }, []);

  // A press outside closes it. Scrolling, the window losing focus and focus moving do not (focus is pulled back below).
  useDismissable(true, { inside: [imgRef, closeRef, navRef], ignore: ['escape', 'focus', 'blur', 'scroll'], onDismiss: onClose });

  // Escape belongs to this layer alone: caught first on the window and stopped, so nothing behind it (a side box, a sheet) also closes.
  const closeNow = useRef(onClose);
  closeNow.current = onClose;
  useEffect(() => {
    const onEsc = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeNow.current();
    };
    window.addEventListener('keydown', onEsc, true);
    // Focus never leaves the viewer: if something behind it gets focus, it goes back to Close.
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) closeRef.current?.focus();
    };
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      window.removeEventListener('keydown', onEsc, true);
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, []);

  const step = (by: number) => {
    if (total > 1) onIndex((at + by + total) % total);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        step(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        step(1);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });

  // Tab stays inside the buttons of the viewer.
  const trap = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const buttons = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    if (buttons.length === 0) return;
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !rootRef.current?.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!current) return null;
  const node = (
    <div ref={rootRef} className="ck-lightbox" role="dialog" aria-modal="true" aria-label={current.name} data-testid={testId} tabIndex={-1} onKeyDown={trap} onMouseDown={() => rootRef.current?.focus()}>
      <div className="ck-lightbox-name" title={current.name}>
        {current.name}
      </div>
      <button ref={closeRef} type="button" className="ck-lightbox-close" data-testid="lightbox-close" aria-label={t('imageViewer.close')} title={t('imageViewer.close')} onClick={onClose}>
        <Icon d="M6 6l12 12M18 6L6 18" />
      </button>
      <div className="ck-lightbox-stage">
        {current.src ? (
          <img ref={imgRef} key={current.key} className="ck-lightbox-img" data-testid="lightbox-img" src={current.src} alt={current.name} draggable={false} />
        ) : (
          <span className="ck-lightbox-loading" role="status">
            {t('imageViewer.loading')}
          </span>
        )}
      </div>
      {many && (
        <div ref={navRef} className="ck-lightbox-nav" data-testid="lightbox-nav">
          <button type="button" className="ck-lightbox-step" data-testid="lightbox-prev" aria-label={t('imageViewer.prev')} title={t('imageViewer.prev')} onClick={() => step(-1)}>
            <Icon d="M15 5l-7 7 7 7" />
          </button>
          <span className="ck-lightbox-count" data-testid="lightbox-count" aria-live="polite">
            {t('imageViewer.count', { n: at + 1, total })}
          </span>
          <button type="button" className="ck-lightbox-step" data-testid="lightbox-next" aria-label={t('imageViewer.next')} title={t('imageViewer.next')} onClick={() => step(1)}>
            <Icon d="M9 5l7 7-7 7" />
          </button>
        </div>
      )}
    </div>
  );
  return createPortal(node, document.querySelector('.cockpit, .pwa-shell') ?? document.body);
}
