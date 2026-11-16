// Settings > Helpers > Crews (Labs "Crews", crews_enabled): one plain line, your crews, and the ready-made ones. Each opens
// on the crew canvas (components/crews/CrewCanvas.tsx). The lists are read when the page opens and after a save.
// 1.1.8 slot (Templates and sharing): the ready-made list becomes a gallery with "How we work" and a share-as-file button.
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../../i18n';
import { crewsApi as liveCrewsApi, type CrewsApi, type CrewSummary } from '../../../lib/crews-api';
import { CrewCanvas } from '../../crews/CrewCanvas';
import '../../../styles/crews.css';

type State = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; crews: CrewSummary[]; templates: CrewSummary[] };

export function CrewsPage({ api = liveCrewsApi }: { api?: Pick<CrewsApi, 'list' | 'templates'> & Partial<CrewsApi> }) {
  const t = useT();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    let alive = true;
    Promise.all([api.list(), api.templates().catch(() => [] as CrewSummary[])])
      .then(([crews, templates]) => alive && setState({ kind: 'ready', crews, templates }))
      .catch(() => alive && setState({ kind: 'failed' }));
    return () => {
      alive = false;
    };
  }, [api]);
  useEffect(() => load(), [load]);

  const row = (crew: CrewSummary, action: string) => (
    <li key={crew.slug} className="crews-row" data-testid="crew-row">
      <span className="crews-row-name">{crew.name}</span>
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
      {state.kind === 'ready' && state.templates.length > 0 ? (
        <>
          <h4 className="crews-sub">{t('crewcanvas.page.ready')}</h4>
          <ul className="crews-list" aria-label={t('crewcanvas.page.ready')}>
            {state.templates.map((crew) => row(crew, t('crewcanvas.page.look')))}
          </ul>
        </>
      ) : null}
      {open ? <CrewCanvas slug={open} api={api as CrewsApi} onClose={() => setOpen(null)} onSaved={() => load()} /> : null}
    </section>
  );
}
