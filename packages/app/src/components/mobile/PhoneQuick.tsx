// Quick replies and saved prompts above the phone's message box (P17). The chips are made from what the agent asked; a chip
// only FILLS the box and the person presses Send. A "/" at the start of the box opens the saved prompts, which are kept on
// this phone only (the list can be edited right there).
import { useState } from 'react';
import { useT, type MessageKey } from '../../i18n';
import { MAX_SAVED_CHARS, MAX_SAVED_PROMPTS, type QuickKind } from '../../lib/phone-quick';
import '../../styles/phone-compose.css';

const STARTERS: readonly MessageKey[] = ['phone.quick.starter1', 'phone.quick.starter2', 'phone.quick.starter3'];

/** The starter prompts, in the phone's language, shown until the person changes the list. */
export function starterPrompts(t: (key: MessageKey) => string): string[] {
  return STARTERS.map((key) => t(key));
}

export function QuickReplies({ kinds, onPick }: { kinds: readonly QuickKind[]; onPick: (text: string) => void }) {
  const t = useT();
  if (kinds.length === 0) return null;
  return (
    <div className="ph-quick" role="group" aria-label={t('phone.quick.aria')} data-testid="phone-quick">
      {kinds.map((kind) => {
        const text = t(`phone.quick.${kind}` as MessageKey);
        return (
          <button key={kind} type="button" className="ph-quick-chip" onClick={() => onPick(text)}>
            {text}
          </button>
        );
      })}
    </div>
  );
}

export function SavedPrompts({
  prompts,
  filter,
  onPick,
  onAdd,
  onRemove,
  onClose,
}: {
  prompts: readonly string[];
  /** What the person typed after the slash. */
  filter: string;
  onPick: (text: string) => void;
  onAdd: (text: string) => void;
  onRemove: (text: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState('');
  const save = () => {
    if (draft.trim() === '') return;
    onAdd(draft);
    setDraft('');
  };
  const shown = prompts.filter((p) => filter === '' || p.toLowerCase().includes(filter));
  return (
    <div
      className="ph-saved"
      role="group"
      aria-label={t('phone.quick.savedAria')}
      data-testid="phone-saved"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div className="ph-saved-head">
        <span>{t('phone.quick.savedTitle')}</span>
        <button type="button" className="ph-saved-close" onClick={onClose}>
          {t('phone.quick.close')}
        </button>
      </div>
      {shown.length === 0 && <p className="ph-saved-empty">{t('phone.quick.none')}</p>}
      <ul className="ph-saved-list">
        {shown.map((prompt) => (
          <li key={prompt}>
            <button type="button" className="ph-saved-pick" onClick={() => onPick(prompt)}>
              {prompt}
            </button>
            <button type="button" className="ph-saved-del" aria-label={t('phone.quick.remove', { text: prompt })} onClick={() => onRemove(prompt)}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </li>
        ))}
      </ul>
      {prompts.length < MAX_SAVED_PROMPTS && (
        <div className="ph-saved-add">
          <input
            value={draft}
            maxLength={MAX_SAVED_CHARS}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                save();
              }
            }}
            aria-label={t('phone.quick.newAria')}
            placeholder={t('phone.quick.newPlaceholder')}
          />
          <button type="button" disabled={draft.trim() === ''} onClick={save}>
            {t('phone.quick.add')}
          </button>
        </div>
      )}
    </div>
  );
}
