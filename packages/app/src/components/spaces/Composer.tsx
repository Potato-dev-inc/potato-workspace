import { useState, type KeyboardEvent } from 'react';
import { MAX_TEXT_CHARS, type SpaceMessage } from '../../lib/spaces';

/** The counter shows from this size on (90% of the cap). */
export const COUNT_FROM_CHARS = 3600;

/** Characters as the Rust side counts them (code points, not UTF-16 units). */
export function charLength(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

export interface ComposerProps {
  channelName: string;
  replyTo: SpaceMessage | null;
  onCancelReply: () => void;
  onSend: (text: string) => Promise<string | null>; // returns an error text or null
  disabled?: boolean;
}

export function Composer({ channelName, replyTo, onCancelReply, onSend, disabled }: ComposerProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chars = charLength(text);
  const tooLong = chars > MAX_TEXT_CHARS;
  const send = async () => {
    if (busy || tooLong || text.trim() === '') return;
    setBusy(true);
    const err = await onSend(text);
    setBusy(false);
    if (err) { setError(err); return; }
    setError(null); setText(''); onCancelReply();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
  };
  return (
    <div className="ck-spaces-composer">
      {replyTo && (
        <div className="ck-spaces-composer-reply">
          <span>Replying to {replyTo.authorName}</span>
          <button type="button" className="ck-spaces-link" onClick={onCancelReply}>Cancel reply</button>
        </div>
      )}
      <textarea aria-label={`Message #${channelName}`} placeholder={`Message #${channelName}`} rows={1}
        value={text} disabled={disabled || busy} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
      {chars > COUNT_FROM_CHARS && (
        <span className={`ck-spaces-count${tooLong ? ' is-error' : ''}`}>{chars} / {MAX_TEXT_CHARS}</span>
      )}
      {tooLong && <p className="ck-spaces-hint is-error">This message is too long. The limit is {MAX_TEXT_CHARS} characters.</p>}
      {error && <p className="ck-spaces-hint is-error" role="alert">{error}</p>}
      <button type="button" className="ck-spaces-btn is-primary" disabled={disabled || busy || tooLong || text.trim() === ''}
        onClick={() => void send()}>Send</button>
    </div>
  );
}
