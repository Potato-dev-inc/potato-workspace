import { useState } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import type { ShareLevel, ShareView, TeamApi } from '../../lib/team';

const LEVELS: readonly ShareLevel[] = ['nothing', 'here', 'project', 'title'];

const LABEL = {
  nothing: ['teamHub.share.nothing', 'teamHub.share.nothing.help'],
  here: ['teamHub.share.here', 'teamHub.share.here.help'],
  project: ['teamHub.share.project', 'teamHub.share.project.help'],
  title: ['teamHub.share.title.opt', 'teamHub.share.title.help'],
} as const;

/**
 * "Share what I am doing": one choice of four, and the projects that never share their name. Nothing is shared past
 * "here" until the person picks it. The words are cleaned on this PC before they are sent (Rust side).
 */
export function ShareSheet({ share, api, onClose, onSaved }: { share: ShareView; api: TeamApi; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [level, setLevel] = useState<ShareLevel>(share.level);
  const [exclude, setExclude] = useState(share.exclude.join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!api.shareSet) {
      setError(t('teamHub.share.failed'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.shareSet(
        level,
        exclude
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      );
      onSaved();
      onClose();
    } catch (err) {
      setError(errorSentence(err) || t('teamHub.share.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tpg-sheet" role="dialog" aria-label={t('teamHub.share.title')} data-testid="share-sheet">
      <h3 className="tpg-sheet-title">{t('teamHub.share.title')}</h3>
      <fieldset className="tpg-radios">
        <legend className="tpg-sr">{t('teamHub.share.title')}</legend>
        {LEVELS.map((l) => (
          <label key={l} className="tpg-radio">
            <input type="radio" name="team-share-level" value={l} checked={level === l} onChange={() => setLevel(l)} />
            <span>
              <strong>{t(LABEL[l][0])}</strong>
              <small>{t(LABEL[l][1])}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="tpg-field">
        <span>{t('teamHub.share.exclude')}</span>
        <textarea rows={3} value={exclude} onChange={(e) => setExclude(e.target.value)} aria-describedby="tpg-exclude-help" />
        <small id="tpg-exclude-help">{t('teamHub.share.excludeHelp')}</small>
      </label>
      <p className="tpg-note">{t('teamHub.share.foot')}</p>
      {error && (
        <p className="tpg-error" role="alert">
          {error}
        </p>
      )}
      <div className="tpg-actions">
        <button type="button" className="ck-btn ck-btn--primary" disabled={busy} onClick={() => void save()}>
          {t('teamHub.share.save')}
        </button>
        <button type="button" className="ck-btn ck-btn--plain" onClick={onClose}>
          {t('teamHub.share.cancel')}
        </button>
      </div>
    </div>
  );
}
