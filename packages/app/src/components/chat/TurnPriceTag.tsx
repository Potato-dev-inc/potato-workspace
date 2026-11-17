// The quiet line under a finished answer: "4m 5s · 18 steps · 3 files changed". A turn far above what is usual for
// this chat gets a small mark and one plain tip, which "Don't show again" can hide for good (lib/usual-notes.ts).
// Press the line for the files it changed. Only what the chat already holds is used (see lib/turnPrice.ts).
import { useState } from 'react';
import { useT } from '../../i18n';
import { baseName, formatDuration } from './chatFormat';
import { formatTokens } from '../cockpit/rail/railFormat';
import type { TurnPrice } from '../../lib/turnPrice';
import { setUsualNotesOn, useUsualNotesOn } from '../../lib/usual-notes';
import '../../styles/chat-ux.css';

export function TurnPriceTag({ price }: { price: TurnPrice }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // The "more than usual" note (mark and tip) is gone once the person chose "Don't show again".
  const notesOn = useUsualNotesOn();
  const heavy = notesOn ? price.heavy : null;
  const parts: string[] = [];
  if (price.durationMs !== null) parts.push(formatDuration(price.durationMs));
  if (price.steps > 0) parts.push(t('chatUx.price.steps', { count: price.steps }));
  if (price.files.length > 0) parts.push(t('chatUx.price.files', { count: price.files.length }));
  if (price.tokens !== null) parts.push(t('chatUx.price.tokens', { n: formatTokens(price.tokens) }));
  const canOpen = price.files.length > 0;
  const text = parts.join(' · ');
  return (
    <div className="ck-price" data-testid="turn-price" data-heavy={heavy ?? undefined}>
      {canOpen ? (
        <button type="button" className="ck-price-line" aria-expanded={open} aria-label={`${t('chatUx.price.details')}: ${text}`} onClick={() => setOpen(!open)}>
          {heavy && <span className="ck-price-mark" role="img" aria-label={t('chatUx.price.heavy')} />}
          {text}
        </button>
      ) : (
        <span className="ck-price-line">
          {heavy && <span className="ck-price-mark" role="img" aria-label={t('chatUx.price.heavy')} />}
          {text}
        </span>
      )}
      {heavy && (
        <p className="ck-price-tip">
          <span data-testid="turn-price-tip">{heavy === 'reads' ? t('chatUx.price.tipReads', { count: price.reads }) : t('chatUx.price.tipLong')}</span>{' '}
          <button type="button" className="ck-price-dismiss" onClick={() => setUsualNotesOn(false)}>
            {t('chatUx.price.dontShow')}
          </button>
        </p>
      )}
      {open && canOpen && (
        <ul className="ck-price-files" aria-label={t('chatUx.price.filesTitle')}>
          {price.files.map((path) => (
            <li key={path} title={path}>
              {baseName(path)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
