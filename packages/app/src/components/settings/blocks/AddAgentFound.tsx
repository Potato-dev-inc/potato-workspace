// "Found on this computer": the agents the app can already see, each with one-click Add, plus Add all.
// Hidden when the call fails or finds nothing. Adding runs the same flow as typing the name (the box's `onAdd`).
import { useEffect, useState } from 'react';
import { useT } from '../../../i18n';
import type { AddAgentApi, FoundAgent } from '../../../lib/addAgent';
import { Btn } from '../settings-ui';

export function AddAgentFound({
  api,
  projectDir,
  disabled,
  onAdd,
  onAddAll,
}: {
  api: AddAgentApi;
  projectDir?: string | null;
  disabled?: boolean;
  /** Adds one agent by id (runs add_agent_start with that id). */
  onAdd: (id: string) => void;
  /** Adds them all, one after the other. */
  onAddAll: (ids: string[]) => void;
}) {
  const t = useT();
  const [found, setFound] = useState<FoundAgent[]>([]);
  useEffect(() => {
    let alive = true;
    if (!api.detectInstalled) return undefined;
    api
      .detectInstalled(projectDir ?? undefined)
      .then((list) => alive && setFound(Array.isArray(list) ? list : []))
      .catch(() => alive && setFound([]));
    return () => {
      alive = false;
    };
  }, [api, projectDir]);
  if (found.length === 0) return null;
  return (
    <div className="aa-found" role="group" aria-label={t('addAgent.found.title')}>
      <div className="aa-found-head">
        <p className="aa-found-title">{t('addAgent.found.title')}</p>
        {found.length > 1 && (
          <button type="button" className="aa-link" disabled={disabled} onClick={() => onAddAll(found.map((f) => f.id))}>
            {t('addAgent.found.addAll')}
          </button>
        )}
      </div>
      <ul className="aa-found-list">
        {found.map((f) => (
          <li key={f.id} className="aa-found-row" data-found={f.id}>
            <span className="aa-found-name">{f.displayName}</span>
            {f.version ? <span className="aa-quiet">{f.version}</span> : null}
            <Btn small disabled={disabled} aria-label={t('addAgent.found.addOne', { name: f.displayName })} onClick={() => onAdd(f.id)}>
              {t('addAgent.add')}
            </Btn>
          </li>
        ))}
      </ul>
    </div>
  );
}
