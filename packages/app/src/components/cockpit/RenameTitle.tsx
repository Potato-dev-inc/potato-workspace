// The pane title in the cockpit header: double-click (or ⋯ > Rename) to edit in place.
// Enter saves, Escape cancels, a blank name clears it so automatic titling resumes.
import { useEffect, useRef, useState } from 'react';
import { cleanTitleInput, MAX_TITLE_CHARS } from './titles';
import { useT } from '../../i18n';

export interface RenameTitleProps {
  text: string;
  /** The user's own title (or the derived one) when there is one; the editor starts from it. */
  current: string;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onSave: (title: string) => void;
}

export function RenameTitle({ text, current, editing, onEditingChange, onSave }: RenameTitleProps) {
  const t = useT();
  // The editor starts from the name shown, so renaming a long name or fixing a typo does not start from nothing.
  const start = current || cleanTitleInput(text);
  const [draft, setDraft] = useState(start);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(start);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, current]);

  if (!editing) {
    return (
      <h1
        className="ck-title ck-title--sm ck-title--editable"
        title={`${text} · ${t('pane.renameTip')}`}
        onDoubleClick={() => onEditingChange(true)}
      >
        {text}
      </h1>
    );
  }

  const commit = () => {
    onEditingChange(false);
    const next = cleanTitleInput(draft);
    if (next !== start && (next || current)) onSave(next);
  };

  return (
    <>
    <input
      ref={inputRef}
      className="ck-title-input"
      aria-label={t('pane.nameLabel')}
      value={draft}
      maxLength={MAX_TITLE_CHARS}
      placeholder={t('pane.namePlaceholder')}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onEditingChange(false);
        }
      }}
    />
    <span className="ck-title-count" aria-hidden="true">
      {draft.length}/{MAX_TITLE_CHARS}
    </span>
    </>
  );
}
