// The agent's thoughts in the conversation: open with a shimmering "Thinking…" while they stream in, then folded to
// "Thought for 6s" (or "Thought" when the time is not known) once something else comes after them. A click opens them
// again. Plain text only; the fold is CSS.
import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { formatDuration } from './chatFormat';
import '../../styles/chat-decision-card.css';

export function thoughtLabel(streaming: boolean, durationMs: number | null | undefined): string {
  if (streaming) return 'Thinking…';
  return durationMs != null && durationMs >= 1000 ? `Thought for ${formatDuration(durationMs)}` : 'Thought';
}

/** `folded` (the phone): the thoughts stay folded even while they stream; the line says "Thinking…" and a tap opens them. */
/** The same label through t() (English and Traditional Chinese). */
export function useThoughtLabel(): (streaming: boolean, durationMs: number | null | undefined) => string {
  const t = useT();
  return (streaming, durationMs) =>
    streaming ? t('phone.think.thinking') : durationMs != null && durationMs >= 1000 ? t('phone.think.thoughtFor', { time: formatDuration(durationMs) }) : t('phone.think.thought');
}

export function ThinkingBlock({ text, durationMs, streaming, folded = false }: { text: string; durationMs?: number | null; streaming: boolean; folded?: boolean }) {
  const [open, setOpen] = useState(streaming && !folded);
  // Once the person has opened or closed it themselves, the app stops folding it for them.
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setOpen(streaming && !folded);
  }, [streaming, folded]);
  const label = useThoughtLabel();
  const bodyId = useId();
  return (
    <div className="ck-think" data-streaming={streaming ? '' : undefined} data-testid="thinking-block">
      <button
        type="button"
        className="ck-think-h"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          touched.current = true;
          setOpen(!open);
        }}
      >
        <svg className="ck-think-i" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3M4.2 4.2l2 2M9.8 9.8l2 2M11.8 4.2l-2 2M6.2 9.8l-2 2" />
        </svg>
        <span className={streaming ? 'ck-shim' : undefined}>{label(streaming, durationMs)}</span>
        <svg className="ck-think-cv" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      <div id={bodyId} className="ck-think-fold" data-open={open ? '' : undefined}>
        <div className="ck-think-in">
          <p className="ck-think-tx">{text}</p>
        </div>
      </div>
    </div>
  );
}
