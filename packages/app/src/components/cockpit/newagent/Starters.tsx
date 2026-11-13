// Under the New agent box: three one-click starters. The first two put a sentence in the box (nothing starts until
// the person presses Start); the last opens "Bring my chats". The two sentences can also be pinned as a saved
// prompt, which is how the first card gets onto the page (the "Add card" row only shows after that).
import { BringChatsLink } from '../../history/BringChatsLink';
import { useT } from '../../../i18n';

export function Starters({ onUse, onPin }: { onUse: (text: string) => void; onPin?: (text: string) => void }) {
  const t = useT();
  return (
    <div className="ck-na-starters" data-testid="na-starters">
      <p className="ck-na-starters-cap">{t('newAgent.tryOne')}</p>
      <ul className="ck-na-starters-list">
        {[t('newAgent.starter0'), t('newAgent.starter1')].map((text) => (
          <li key={text} className="ck-na-starter-row">
            <button type="button" className="ck-na-starter" onClick={() => onUse(text)}>
              <span>{text}</span>
              <span aria-hidden="true" className="ck-na-starter-go">
                ›
              </span>
            </button>
            {onPin && (
              <button type="button" className="ck-na-starter-pin" aria-label={t('newAgent.pinAria', { text })} title={t('newAgent.pinTip')} onClick={() => onPin(text)}>
                {t('newAgent.pin')}
              </button>
            )}
          </li>
        ))}
        <li className="ck-na-starter-row">
          <BringChatsLink className="ck-na-starter" label={t('newAgent.bringChats')} />
        </li>
      </ul>
    </div>
  );
}
