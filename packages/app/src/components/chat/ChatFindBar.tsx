// The small box at the top right of a chat: type to mark every match, Enter for the next, Shift+Enter for the
// one before, Esc to close and go back to the message box.
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useT } from '../../i18n';
import '../../styles/chat-ux.css';
import type { ChatFind } from './useChatFind';

export function ChatFindBar({ find, belowHead = false }: { find: ChatFind; /** The chat has its own header row: the box sits under it. */ belowHead?: boolean }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      find.close();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) find.prev();
      else find.next();
    }
  };
  const searching = find.query !== '';
  const count = !searching ? '' : find.total === 0 ? t('chatUx.find.none') : t('chatUx.find.count', { n: find.index + 1, total: find.total });
  return (
    <div className={belowHead ? 'ck-find ck-find--below-head' : 'ck-find'} role="search" aria-label={t('chatUx.find.label')} data-testid="chat-find">
      <input
        ref={input}
        type="search"
        className="ck-find-input"
        value={find.query}
        placeholder={t('chatUx.find.placeholder')}
        aria-label={t('chatUx.find.label')}
        onChange={(event) => find.setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="ck-find-count" role="status" aria-live="polite" data-testid="chat-find-count">
        {count}
      </span>
      <button type="button" className="ck-find-btn" aria-label={t('chatUx.find.prev')} title={t('chatUx.find.prev')} disabled={find.total === 0} onClick={find.prev}>
        ↑
      </button>
      <button type="button" className="ck-find-btn" aria-label={t('chatUx.find.next')} title={t('chatUx.find.next')} disabled={find.total === 0} onClick={find.next}>
        ↓
      </button>
      <button type="button" className="ck-find-btn" aria-label={t('chatUx.find.close')} title={t('chatUx.find.close')} onClick={find.close}>
        ×
      </button>
    </div>
  );
}
