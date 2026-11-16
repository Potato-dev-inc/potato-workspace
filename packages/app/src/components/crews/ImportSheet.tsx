// "Open a shared crew": shows what a shared crew file would set up before anything changes: its roles and jobs, the rules, who may
// merge or start helpers, and any problem the crew check found. Nothing is saved or run until "Save to my crews", and that save
// passes the same check as any crew. Reading a file never starts a pane.
import { useState } from 'react';
import { useT } from '../../i18n';
import { DEFAULT_AGENT, crewErrorText, type CrewShareCheck, type CrewsApi } from '../../lib/crews-api';
import { useSheetKeys } from '../cockpit/Sheet';

export function ImportSheet({
  found,
  api,
  onSaved,
  onClose,
}: {
  found: CrewShareCheck;
  api: Pick<CrewsApi, 'saveCanvas'>;
  onSaved: (slug: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useSheetKeys(onClose);
  const [name, setName] = useState(found.crew.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = found.problems.length > 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await api.saveCanvas({ ...found.crew, name }, found.routing_text, false);
      if (out.slug && out.errors.length === 0) {
        onSaved(out.slug);
        return;
      }
      const first = out.errors[0];
      setError(first?.code === 'CREW_NAME_TAKEN' ? t('crewcanvas.nameTaken') : (first?.message ?? t('crewcanvas.saveFailed')));
    } catch (err) {
      setError(crewErrorText(err) || t('crewcanvas.saveFailed'));
    }
    setBusy(false);
  };

  const list = (key: 'merge' | 'helpers' | 'commands', names: string[]) =>
    names.length > 0 ? <li>{t(`crewimport.${key}` as never, { names: names.join(', ') })}</li> : null;

  return (
    <div className="crewc-scrim" onMouseDown={onClose}>
      <div ref={ref} className="crewc-modal crewc-modal--wide" role="dialog" aria-modal="true" aria-labelledby="crewc-import-t" onMouseDown={(e) => e.stopPropagation()} data-testid="import-sheet">
        <h2 id="crewc-import-t">{t('crewimport.title')}</h2>
        <p>{t('crewimport.about', { count: found.crew.roles.length })}</p>
        <label className="crewc-field">
          <span>{t('crewcanvas.name')}</span>
          <input type="text" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <ul className="crewc-result" data-testid="import-facts">
          {list('merge', found.may_merge)}
          {list('helpers', found.may_start_helpers)}
          {list('commands', found.runs_commands)}
          {found.standbys > 0 ? <li>{t('crewimport.standbys', { count: found.standbys })}</li> : null}
        </ul>
        {blocked ? (
          <div className="crewc-error" role="alert" data-testid="import-problems">
            <p>{t('crewimport.problems')}</p>
            <ul>
              {found.problems.map((p, i) => (
                <li key={`${p.code}-${i}`}>{p.message}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <h4>{t('crewimport.roles')}</h4>
        <ul className="crewc-import-roles" data-testid="import-roles">
          {found.crew.roles.map((r) => (
            <li key={r.id || r.name}>
              <strong>{r.name}</strong> <span className="crewc-hint">{r.agent_type === DEFAULT_AGENT ? t('crewcanvas.agent.default') : r.agent_type}</span>
              <details>
                <summary>{t('crewimport.job')}</summary>
                <p className="crewc-import-text">{r.task}</p>
              </details>
            </li>
          ))}
        </ul>
        <details open={found.routing_text.trim().length > 0}>
          <summary>{t('crewimport.rules')}</summary>
          <p className="crewc-hint">{t('crewimport.rulesNote')}</p>
          <pre className="crewc-import-text" data-testid="import-rules">
            {found.routing_text || t('crewimport.noRules')}
          </pre>
        </details>
        <p className="crewc-hint">{t('crewimport.safe')}</p>
        {error ? (
          <p className="crewc-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="crewc-actions">
          <button type="button" className="crewc-btn" onClick={onClose} disabled={busy}>
            {t('crewcanvas.sheet.cancel')}
          </button>
          <button type="button" className="crewc-btn crewc-btn--primary" onClick={() => void save()} disabled={busy || blocked || !name.trim()} title={blocked ? t('crewimport.fixFirst') : undefined}>
            {busy ? t('crewcanvas.saving') : t('crewimport.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
