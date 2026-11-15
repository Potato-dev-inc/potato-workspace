import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import type { TeamApi, TeamConfigView } from '../../lib/team';
import { JoinForm, StartForm } from '../settings/blocks/TeamPage';

/** No team yet (or waiting for the owner's yes): two ways in. The forms are the Settings ones. */
export function EmptyTeam({ api, config, displayName, onConfig }: { api: TeamApi; config: TeamConfigView | null; displayName?: string; onConfig: (view: TeamConfigView) => void }) {
  const t = useT();
  const [mode, setMode] = useState<'choose' | 'start' | 'join'>('choose');
  const [guess, setGuess] = useState(displayName?.trim() ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (guess) return;
    let alive = true;
    void Promise.resolve(api.defaultName?.())
      .then((n) => alive && typeof n === 'string' && setGuess(n))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api, guess]);

  const run = async (what: () => Promise<TeamConfigView>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      onConfig(await what());
      return true;
    } catch (err) {
      setError(errorSentence(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (config?.joining) {
    return (
      <div className="tpg-empty-team" data-testid="team-joining">
        <h2 className="tpg-title">{config.joining}</h2>
        <p className="tpg-sub">{t('teamHub.empty.waiting')}</p>
        <button type="button" className="ck-btn ck-btn--secondary" disabled={busy} onClick={() => void run(() => api.leave())}>
          {t('teamPage.cancelRequest')}
        </button>
      </div>
    );
  }

  return (
    <div className="tpg-empty-team" data-testid="team-empty">
      {mode === 'choose' && (
        <>
          <h2 className="tpg-title">{t('teamHub.empty.title')}</h2>
          <p className="tpg-sub">{t('teamHub.empty.body')}</p>
          <div className="tpg-actions">
            <button type="button" className="ck-btn ck-btn--primary" onClick={() => setMode('start')}>
              {t('teamHub.empty.start')}
            </button>
            <button type="button" className="ck-btn ck-btn--secondary" onClick={() => setMode('join')}>
              {t('teamHub.empty.join')}
            </button>
          </div>
          <p className="tpg-sub">{t('teamHub.empty.solo')}</p>
        </>
      )}
      {mode === 'start' && <StartForm api={api} busy={busy} guess={guess} onBack={() => setMode('choose')} onCreate={(input) => run(() => api.create(input))} />}
      {mode === 'join' && <JoinForm api={api} busy={busy} guess={guess} onBack={() => setMode('choose')} onJoin={(input) => run(() => api.join(input))} onJoinedByLink={() => void api.configGet().then(onConfig).catch(() => undefined)} />}
      {error && (
        <p className="tpg-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
