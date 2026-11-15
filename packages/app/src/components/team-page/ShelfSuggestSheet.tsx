import { useState } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import type { MineView, ShelfApi, ShelfPerson } from '../../lib/shelf';
import { listWords } from './shelf-model';

export const WHY_MAX = 200;

/**
 * "Suggest to...": pick people (or everyone), add one line of why, send. Only the definition goes; the sheet says so,
 * and for a tool it lists the names of the keys that each person adds for themselves.
 */
export function ShelfSuggestSheet({ item, installLine, people, api, onClose, onSent }: { item: MineView; installLine?: string; people: ShelfPerson[]; api: ShelfApi; onClose: () => void; onSent: () => void }) {
  const t = useT();
  const [picked, setPicked] = useState<string[]>([]);
  const [everyone, setEveryone] = useState(false);
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const toggle = (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const ready = everyone || picked.length > 0;

  const send = async () => {
    setBusy(true);
    setError(null);
    const to = everyone ? [] : picked;
    try {
      await api.suggest(item.id, to, why.trim());
      setSentTo(everyone ? t('teamHub.shelf.sent.team') : t('teamHub.shelf.sent.people', { names: listWords(people.filter((p) => picked.includes(p.id)).map((p) => p.name)) }));
      onSent();
    } catch (err) {
      setError(errorSentence(err) || t('teamHub.shelf.suggestFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tpg-sheet tpg-shelf-sheet" role="dialog" aria-label={t('teamHub.shelf.suggest.title', { name: item.name })} data-testid="shelf-suggest-sheet">
      <h3 className="tpg-sheet-title">{t('teamHub.shelf.suggest.title', { name: item.name })}</h3>
      {sentTo ? (
        <>
          <p role="status" data-testid="shelf-sent-line">
            {sentTo}
          </p>
          <div className="tpg-actions">
            <button type="button" className="ck-btn ck-btn--plain" onClick={onClose}>
              {t('teamHub.shelf.close')}
            </button>
          </div>
        </>
      ) : (
        <>
          <fieldset className="tpg-radios">
            <legend className="tpg-sr">{t('teamHub.shelf.suggest.who')}</legend>
            <label className="tpg-radio">
              <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
              <span>
                <strong>{t('teamHub.shelf.everyone')}</strong>
              </span>
            </label>
            {people.map((p) => (
              <label key={p.id} className="tpg-radio">
                <input type="checkbox" checked={everyone || picked.includes(p.id)} disabled={everyone} onChange={() => toggle(p.id)} />
                <span>{p.name}</span>
              </label>
            ))}
            {people.length === 0 && <p className="tpg-sub">{t('teamHub.shelf.noPeople')}</p>}
          </fieldset>
          <label className="tpg-field">
            <span>{t('teamHub.shelf.why')}</span>
            <input className="tpg-field-input" type="text" maxLength={WHY_MAX} value={why} onChange={(e) => setWhy(e.target.value)} placeholder={t('teamHub.shelf.why.hint')} />
            <small>{t('teamHub.shelf.why.count', { n: why.length, max: WHY_MAX })}</small>
          </label>
          <p className="tpg-note">{installLine ? t('teamHub.shelf.suggest.installSends', { line: installLine }) : t('teamHub.shelf.suggest.sends')}</p>
          {item.needs.length > 0 && <p className="tpg-note">{t('teamHub.shelf.suggest.keys', { names: item.needs.join(', ') })}</p>}
          {item.skippedFiles > 0 && <p className="tpg-note">{t('teamHub.shelf.skipped', { count: item.skippedFiles })}</p>}
          {error && (
            <p className="tpg-error" role="alert">
              {error}
            </p>
          )}
          <div className="tpg-actions">
            <button type="button" className="ck-btn ck-btn--primary" disabled={!ready || busy} onClick={() => void send()}>
              {t('teamHub.shelf.send')}
            </button>
            <button type="button" className="ck-btn ck-btn--plain" onClick={onClose}>
              {t('teamHub.shelf.cancel')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
