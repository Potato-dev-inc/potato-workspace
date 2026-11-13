// Under the New agent box: three one-click starters. The first two put a sentence in the box (nothing starts until
// the person presses Start); the last opens "Bring my chats". The two sentences can also be pinned as a saved
// prompt, which is how the first card gets onto the page (the "Add card" row only shows after that).
import { BringChatsLink } from '../../history/BringChatsLink';

export const STARTER_PROMPTS: readonly string[] = ['Explain how this project is organised', 'Find and fix one small bug'];

export function Starters({ onUse, onPin }: { onUse: (text: string) => void; onPin?: (text: string) => void }) {
  return (
    <div className="ck-na-starters" data-testid="na-starters">
      <p className="ck-na-starters-cap">Try one</p>
      <ul className="ck-na-starters-list">
        {STARTER_PROMPTS.map((text) => (
          <li key={text} className="ck-na-starter-row">
            <button type="button" className="ck-na-starter" onClick={() => onUse(text)}>
              <span>{text}</span>
              <span aria-hidden="true" className="ck-na-starter-go">
                ›
              </span>
            </button>
            {onPin && (
              <button type="button" className="ck-na-starter-pin" aria-label={`Pin "${text}" as a shortcut`} title="Pin as a shortcut" onClick={() => onPin(text)}>
                Pin
              </button>
            )}
          </li>
        ))}
        <li className="ck-na-starter-row">
          <BringChatsLink className="ck-na-starter" label="Bring my chats from another agent" />
        </li>
      </ul>
    </div>
  );
}
