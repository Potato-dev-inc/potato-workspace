// The quiet row under a finished reply: Copy (the whole message) and, on the newest turn, Retry (the turn's existing
// retry). Seen when the reply is hovered or has focus; dimmed (not hidden) on a touch screen, where there is no hover.
import { useState } from 'react';
import { formatKey, isMacPlatform } from '../../lib/shortcuts';
import { useCopy } from './useCopy';
import { t } from '../../i18n';

const COPY = 'M5.5 5.5h6v7h-6zM3.5 10.5v-7h6';
const TICK = 'M3.5 8.5l3 3 6-7';
const RETRY = 'M3 8a5 5 0 1 0 1.6-3.7M3 3v2.6h2.6';

function Svg({ d }: { d: string }) {
  return (
    <svg className="ck-act-i" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function ResponseActions({ text, targetRef, onRetry }: { text: string; targetRef: React.RefObject<HTMLElement | null>; onRetry?: () => Promise<string | null> }) {
  const { state, copy } = useCopy();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const retry = () => {
    if (!onRetry || busy) return;
    setBusy(true);
    setNote(null);
    onRetry()
      .then(setNote, () => setNote(t('resp.failed')))
      .finally(() => setBusy(false));
  };
  return (
    <div className="ck-acts" role="group" aria-label={t('resp.actions')} data-testid="response-actions">
      <button type="button" className="ck-act" aria-label={state === 'idle' ? t('resp.copy') : state === 'copied' ? t('resp.copied') : `Selected, press ${formatKey('Mod+C', isMacPlatform())}`} data-tip={state === 'idle' ? t('resp.copy') : state === 'copied' ? t('resp.copied') : 'Selected: copy it yourself'} onClick={() => void copy(text, targetRef.current)}>
        <Svg d={state === 'copied' ? TICK : COPY} />
      </button>
      {onRetry && (
        <button type="button" className="ck-act" aria-label={t('resp.retry')} data-tip={busy ? t('resp.sending') : t('resp.retry')} disabled={busy} onClick={retry}>
          <Svg d={RETRY} />
        </button>
      )}
      {note && (
        <span className="ck-act-note" role="alert">
          {note}
        </span>
      )}
    </div>
  );
}
