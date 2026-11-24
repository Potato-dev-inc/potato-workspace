// Settings > Helpers > Crews (Labs "Crews", crews_enabled): one plain line, your crews, and the ready-made ones. Each opens
// on the crew canvas (components/crews/CrewCanvas.tsx). The lists are read when the page opens and after a save.
// 1.1.8 Templates and sharing: the ready-made crews are a gallery (the starters and the templates, "How we work" among them), and
// "Open a shared crew" reads a crew file and shows what it would set up before anything is saved.
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../../i18n';
import { crewErrorText, crewsApi as liveCrewsApi, type CrewShareCheck, type CrewsApi, type CrewSummary } from '../../../lib/crews-api';
import { CrewCanvas } from '../../crews/CrewCanvas';
import { CrewGallery } from '../../crews/CrewGallery';
import { crewName } from '../../../lib/crewNames';
import { ImportSheet } from '../../crews/ImportSheet';
import '../../../styles/crews.css';

type State = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; crews: CrewSummary[]; templates: CrewSummary[] };

export function CrewsPage({ api = liveCrewsApi, workflows = false }: { api?: Pick<CrewsApi, 'list' | 'templates'> & Partial<CrewsApi>; workflows?: boolean }) {
  const t = useT();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [open, setOpen] = useState<string | null>(null);
  const [shared, setShared] = useState<CrewShareCheck | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const openShared = async () => {
    setImportError(null);
    try {
      const found = await api.importFile?.();
      if (found) setShared(found);
    } catch (err) {
      setImportError(crewErrorText(err) || t('crewimport.failed'));
    }
  };

  const load = useCallback(() => {
    let alive = true;
    Promise.all([api.list(), api.templates().catch(() => [] as CrewSummary[]), (api.starters?.() ?? Promise.resolve([] as CrewSummary[])).catch(() => [] as CrewSummary[])])
      .then(([crews, templates, starters]) => alive && setState({ kind: 'ready', crews, templates: [...templates, ...starters] }))
      .catch(() => alive && setState({ kind: 'failed' }));
    return () => {
      alive = false;
    };
  }, [api]);
  useEffect(() => load(), [load]);

  const row = (crew: CrewSummary, action: string) => (
    <li key={crew.slug} className="crews-row" data-testid="crew-row">
      <span className="crews-row-name">{crewName(crew)}</span>
      <span className="crews-row-meta">
        {t('crews.page.roles', { count: crew.roles })}
        {crew.agents.length > 0 ? ` · ${crew.agents.join(', ')}` : ''}
      </span>
      {crew.problem ? <span className="crews-row-problem">{t('crews.page.problem', { why: crew.problem })}</span> : null}
      <button type="button" className="crews-open" onClick={() => setOpen(crew.slug)}>
        {action}
      </button>
    </li>
  );

  return (
    <section className="crews-page" aria-label={t('crews.page.aria')}>
      <p className="crews-note">{t('crews.page.coming')}</p>
      {state.kind === 'failed' ? <p className="crews-note">{t('crews.page.loadFailed')}</p> : null}
      {state.kind === 'ready' && state.crews.length === 0 ? <p className="crews-note">{t('crews.page.none')}</p> : null}
      {state.kind === 'ready' && state.crews.length > 0 ? (
        <ul className="crews-list" aria-label={t('crews.page.saved')}>
          {state.crews.map((crew) => row(crew, t('crewcanvas.page.open')))}
        </ul>
      ) : null}
      {state.kind === 'ready' ? <CrewGallery crews={state.templates} empty={state.crews.length === 0} onLook={setOpen} /> : null}
      {api.importFile ? (
        <div className="crews-share">
          <button type="button" className="crews-open" onClick={() => void openShared()}>
            {t('crewimport.open')}
          </button>
          <span className="crews-note">{t('crewimport.hint')}</span>
          {importError ? (
            <span className="crews-row-problem" role="alert">
              {importError}
            </span>
          ) : null}
        </div>
      ) : null}
      {shared ? (
        <ImportSheet
          found={shared}
          api={api as CrewsApi}
          onClose={() => setShared(null)}
          onSaved={(slug) => {
            setShared(null);
            load();
            setOpen(slug);
          }}
        />
      ) : null}
      {open ? <CrewCanvas slug={open} api={api as CrewsApi} workflows={workflows} onClose={() => setOpen(null)} onSaved={() => load()} /> : null}
    </section>
  );
}
