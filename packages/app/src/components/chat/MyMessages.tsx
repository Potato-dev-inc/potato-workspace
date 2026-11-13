// "My messages" (Ctrl+R in the message box): search what you sent, in this chat first and then in any chat. Enter puts
// the chosen message in the box; nothing is ever sent from here. Up/Down move, Esc closes.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '../../i18n';
import { searchChats } from '../../lib/chatSearch';
import { mergeMine, ownMatches } from '../../lib/myMessages';
import '../../styles/chat-ux.css';

/** How long typing rests before the other chats are searched. */
const SEARCH_WAIT_MS = 200;

export function MyMessages({ history, onPick, onClose }: { history: readonly string[]; onPick: (text: string) => void; onClose: () => void }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [others, setOthers] = useState<string[]>([]);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  // Other chats: only when something is typed (an empty search has nothing to look for).
  useEffect(() => {
    const text = query.trim();
    if (text === '') {
      setOthers([]);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      searchChats(text, 30, { role: 'you' }).then(
        (answer) => {
          if (live) setOthers(answer.hits.map((hit) => hit.snippet));
        },
        () => {
          if (live) setOthers([]);
        },
      );
    }, SEARCH_WAIT_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const items = mergeMine(ownMatches(history, query), others);
  const chosen = Math.min(at, Math.max(items.length - 1, 0));
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (items.length > 0) setAt((chosen + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (items[chosen] !== undefined) onPick(items[chosen]);
    }
  };
  return (
    <div className="ck-mine" role="dialog" aria-label={t('chatUx.mine.title')} data-testid="my-messages">
      <input
        ref={input}
        type="search"
        className="ck-mine-input"
        role="combobox"
        aria-expanded={items.length > 0}
        aria-controls="ck-mine-list"
        aria-activedescendant={items.length > 0 ? `ck-mine-opt-${chosen}` : undefined}
        aria-label={t('chatUx.mine.title')}
        placeholder={t('chatUx.mine.placeholder')}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setAt(0);
        }}
        onKeyDown={onKeyDown}
      />
      {items.length === 0 ? (
        <p className="ck-mine-note">{query.trim() === '' ? t('chatUx.mine.empty') : t('chatUx.mine.none')}</p>
      ) : (
        <ul className="ck-mine-list" id="ck-mine-list" role="listbox" aria-label={t('chatUx.mine.title')}>
          {items.map((text, i) => (
            <li
              key={text}
              id={`ck-mine-opt-${i}`}
              role="option"
              aria-selected={i === chosen}
              className="ck-mine-opt"
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setAt(i)}
              onClick={() => onPick(text)}
            >
              {text}
            </li>
          ))}
        </ul>
      )}
      <p className="ck-mine-note">{t('chatUx.mine.hint')}</p>
      <button type="button" className="ck-find-btn ck-mine-close" aria-label={t('chatUx.mine.close')} onClick={onClose}>
        ×
      </button>
    </div>
  );
}
