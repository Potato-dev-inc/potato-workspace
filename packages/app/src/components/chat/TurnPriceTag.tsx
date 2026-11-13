// The quiet line under a finished answer: "4m 5s · 18 steps · 3 files changed". A turn far above what is usual for
// this chat gets a small mark and one plain tip. Press the line for the files it changed. Only what the chat already
// holds is used (see lib/turnPrice.ts).
import { useState } from 'react';
import { useT } from '../../i18n';
import { baseName, formatDuration } from './chatFormat';
import { formatTokens } from '../cockpit/rail/railFormat';
import type { TurnPrice } from '../../lib/turnPrice';
import '../../styles/chat-ux.css';

export function TurnPriceTag({ price }: { price: TurnPrice }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const parts: string[] = [];
  if (price.durationMs !== null) parts.push(formatDuration(price.durationMs));
  if (price.steps > 0) parts.push(t('chatUx.price.steps', { count: price.steps }));
  if (price.files.length > 0) parts.push(t('chatUx.price.files', { count: price.files.length }));
  if (price.tokens !== null) parts.push(t('chatUx.price.tokens', { n: formatTokens(price.tokens) }));
  const canOpen = price.files.length > 0;
  const text = parts.join(' · ');
  return (
    <div className="ck-price" data-testid="turn-price" data-heavy={price.heavy ?? undefined}>
      {canOpen ? (
        <button type="button" className="ck-price-line" aria-expanded={open} aria-label={`${t('chatUx.price.details')}: ${text}`} onClick={() => setOpen(!open)}>
          {price.heavy && <span className="ck-price-mark" role="img" aria-label={t('chatUx.price.heavy')} />}
          {text}
        </button>
      ) : (
        <span className="ck-price-line">
          {price.heavy && <span className="ck-price-mark" role="img" aria-label={t('chatUx.price.heavy')} />}
          {text}
        </span>
      )}
      {price.heavy && (
        <p className="ck-price-tip" data-testid="turn-price-tip">
          {price.heavy === 'reads' ? t('chatUx.price.tipReads', { count: price.reads }) : t('chatUx.price.tipLong')}
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
