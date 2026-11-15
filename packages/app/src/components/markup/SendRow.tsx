// The send row above the bar: a small picture of the page with the marks, "What should change?", how many marks, who
// gets it, and Send. Nothing is sent by drawing alone; the person always sees the picture before Send.
import { useEffect, useRef } from 'react';
import { useT } from '../../i18n';
import { MAX_REQUEST } from '../../lib/markup/model';

export function SendRow({
  thumb,
  taking,
  noPicture,
  marks,
  elements,
  request,
  needText,
  busy,
  onRequest,
  onSend,
}: {
  thumb: string | null;
  taking: boolean;
  noPicture: boolean;
  marks: number;
  elements: number;
  request: string;
  /** The person pressed Send with nothing to say. */
  needText: boolean;
  busy: boolean;
  onRequest: (value: string) => void;
  onSend: () => void;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    if (needText) input.current?.focus();
  }, [needText]);
  const count = t('markup.count', { count: marks }) + (elements > 0 ? ` · ${t('markup.elements', { count: elements })}` : '');
  return (
    <div className="mk-sendrow" data-testid="markup-sendrow">
      {thumb ? (
        <img className="mk-thumb" src={thumb} alt={t('markup.shotOf')} data-testid="markup-thumb" />
      ) : (
        <div className="mk-thumb mk-thumb--none" role="status">
          {taking ? t('markup.taking') : noPicture ? t('markup.noPicture') : ''}
        </div>
      )}
      <div className="mk-col">
        <input
          ref={input}
          className="mk-req"
          value={request}
          maxLength={MAX_REQUEST}
          placeholder={needText ? t('markup.requestNeeded') : t('markup.request')}
          aria-label={t('markup.request')}
          data-testid="markup-request"
          onChange={(e) => onRequest(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <div className="mk-meta">
          <span data-testid="markup-count">{count}</span>
          <span className="mk-grow" />
          <span>{t('markup.to')}</span>
          <button type="button" className="mk-send" disabled={busy || taking} onClick={onSend} data-testid="markup-go">
            {t('markup.send')}
          </button>
        </div>
      </div>
    </div>
  );
}
