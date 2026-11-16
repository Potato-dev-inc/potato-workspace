// "Try a task": type a task, see which role it would go to and the way it would travel, and pick another role instead.
// A dry run: nothing runs and nothing is sent (the note says so). The way is lit on the canvas through `onPath`.
// 1.1.8 slot (Follow a task): this is where a real task's path would be replayed, box by box, with its hand-overs.
// (Change the crew by talking is built: the Talk tab, TalkToCrew.tsx.)
import { useState } from 'react';
import { useT } from '../../i18n';
import { crewErrorText, type Crew, type CrewRoutePreview, type CrewsApi } from '../../lib/crews-api';
import { findRole, keyOf, pathFor } from './model';

export function TryTask({
  crew,
  routingText,
  onRoutingText,
  api,
  disabled,
  onPath,
}: {
  crew: Crew;
  routingText: string;
  onRoutingText: (text: string) => void;
  api: Pick<CrewsApi, 'tryTask'>;
  /** The rules cannot be changed (a ready-made crew). */
  disabled: boolean;
  onPath: (path: string[]) => void;
}) {
  const t = useT();
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CrewRoutePreview | null | undefined>(undefined);
  const [chosen, setChosen] = useState<string | null>(null);

  const show = async () => {
    if (!task.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const found = await api.tryTask(crew, routingText, task);
      setPreview(found);
      setChosen(null);
      onPath(found?.path ?? []);
    } catch (err) {
      setError(crewErrorText(err) || t('crewcanvas.try.failed'));
    }
    setBusy(false);
  };

  const pick = (value: string) => {
    if (!preview) return;
    const next = value === '' ? null : value;
    setChosen(next);
    onPath(next ? pathFor(crew, next) : preview.path);
  };

  const route = chosen ?? preview?.route.role ?? null;
  const way = route ? (chosen ? pathFor(crew, chosen) : (preview?.path ?? [])) : [];
  const nameOf = (id: string) => (findRole(crew, id) ?? { name: id }).name;

  return (
    <div className="crewc-try" data-testid="try-task">
      <label className="crewc-field">
        <span>{t('crewcanvas.try.label')}</span>
        <textarea rows={3} value={task} placeholder={t('crewcanvas.try.placeholder')} onChange={(e) => setTask(e.target.value)} />
      </label>
      <button type="button" className="crewc-btn crewc-btn--primary" disabled={busy || !task.trim()} onClick={() => void show()}>
        {busy ? t('crewcanvas.try.busy') : t('crewcanvas.try.go')}
      </button>
      <p className="crewc-hint">{t('crewcanvas.try.note')}</p>
      {error ? (
        <p className="crewc-error" role="alert">
          {error}
        </p>
      ) : null}
      {preview === null ? <p className="crewc-hint">{t('crewcanvas.try.none')}</p> : null}
      {preview ? (
        <div className="crewc-way" aria-live="polite">
          <h4>{t('crewcanvas.try.way')}</h4>
          <ol className="crewc-path" data-testid="try-path">
            {way.map((id) => (
              <li key={id}>{nameOf(id)}</li>
            ))}
          </ol>
          {!chosen ? <p>{preview.route.why}</p> : null}
          {preview.needs_you.length > 0 ? <p className="crewc-warn">{t('crewcanvas.try.youFirst', { words: preview.needs_you.join(', ') })}</p> : null}
          <label className="crewc-field">
            <span>{t('crewcanvas.try.other')}</span>
            <select value={chosen ?? ''} onChange={(e) => pick(e.target.value)}>
              <option value="">{t('crewcanvas.try.keep')}</option>
              {crew.roles
                .filter((r) => keyOf(r) !== preview.route.role)
                .map((r) => (
                  <option key={keyOf(r)} value={keyOf(r)}>
                    {r.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
      ) : null}
      <details className="crewc-rules">
        <summary>{t('crewcanvas.rules')}</summary>
        <p className="crewc-hint">{t('crewcanvas.rules.help')}</p>
        <textarea rows={10} value={routingText} disabled={disabled} aria-label={t('crewcanvas.rules')} onChange={(e) => onRoutingText(e.target.value)} />
      </details>
    </div>
  );
}
