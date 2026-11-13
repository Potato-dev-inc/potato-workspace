// Settings > Agents: "Warn me when two agents change the same file" (on by default). Saves itself the moment you
// flip it, through the collision settings command. It only warns: nothing here pauses or stops an agent.
import { useEffect, useState } from 'react';
import { en } from '../../../i18n/en';
import { useT } from '../../../i18n';
import { tauriCollisionApi, type CollisionApi, type CollisionSettings } from '../../../lib/collision';
import { Note, SettingToggle } from '../settings-ui';

export const COLLISION_LABEL = en['settings.row.collision.label'];
export const COLLISION_FOOTER = en['collision.footer'];
export const COLLISION_SAVE_FAILED = en['collision.saveFailed'];

export function CollisionSettings({ api = tauriCollisionApi, onSaved }: { api?: CollisionApi; onSaved?: () => void }) {
  const t = useT();
  const [current, setCurrent] = useState<CollisionSettings | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.settingsGet().then(
      (value) => {
        if (!alive) return;
        setCurrent(value);
        setStatus('ready');
      },
      () => {
        if (alive) setStatus('unavailable');
      },
    );
    return () => {
      alive = false;
    };
  }, [api]);

  if (status === 'loading') return null;

  const change = (enabled: boolean) => {
    const previous = current;
    if (!previous) return;
    setCurrent({ ...previous, enabled });
    setError(null);
    api.settingsSet({ enabled }).then(
      (saved) => {
        setCurrent(saved);
        onSaved?.();
      },
      () => {
        setCurrent(previous);
        setError(t('collision.saveFailed'));
      },
    );
  };

  return (
    <>
      <SettingToggle label={t('settings.row.collision.label')} checked={current?.enabled ?? false} disabled={!current} onChange={change} />
      <Note>{t('collision.footer')}</Note>
      {error && <Note role="alert">{error}</Note>}
    </>
  );
}
