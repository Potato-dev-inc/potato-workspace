// "Tell the agent": shown while lines are selected. A short note is optional; the lines and the note go into the
// chat's message box as a quoted block (nothing is sent until the person presses Send there).
import { useState } from 'react';
import { useT } from '../../i18n';

export function TellBar({ count, onTell, onClear }: { count: number; onTell: (note: string) => void; onClear: () => void }) {
  const t = useT();
  const [note, setNote] = useState('');
  const submit = () => {
    onTell(note);
    setNote('');
  };
  return (
    <div className="ck-ftell" role="region" aria-label={t('files.tellLabel')} data-testid="tell-bar">
      <span className="ck-ftell-count">{t('files.linesSelected', { count })}</span>
      <input
        type="text"
        className="ck-ftell-note"
        value={note}
        placeholder={t('files.tellNote')}
        aria-label={t('files.tellNote')}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') onClear();
        }}
      />
      <button type="button" className="ck-btn ck-btn--primary ck-btn--sm" onClick={submit}>
        {t('files.tell')}
      </button>
      <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" onClick={onClear}>
        {t('files.clear')}
      </button>
    </div>
  );
}
