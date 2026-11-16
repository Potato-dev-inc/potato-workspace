// Settings > Helpers > Crews (Labs "Crews", crews_enabled): one plain line, then the saved crews as a read-only list.
// Nothing here changes a crew: the crew canvas comes later. The list is read when the page opens.
import { useEffect, useState } from 'react';
import { useT } from '../../../i18n';
import { crewsApi as liveCrewsApi, type CrewsApi, type CrewSummary } from '../../../lib/crews-api';
import '../../../styles/crews.css';

type State = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; crews: CrewSummary[] };

export function CrewsPage({ api = liveCrewsApi }: { api?: Pick<CrewsApi, 'list'> }) {
  const t = useT();
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let alive = true;
    api
      .list()
      .then((crews) => alive && setState({ kind: 'ready', crews }))
      .catch(() => alive && setState({ kind: 'failed' }));
    return () => {
      alive = false;
    };
  }, [api]);

  return (
    <section className="crews-page" aria-label={t('crews.page.aria')}>
      <p className="crews-note">{t('crews.page.coming')}</p>
      {state.kind === 'failed' ? <p className="crews-note">{t('crews.page.loadFailed')}</p> : null}
      {state.kind === 'ready' && state.crews.length === 0 ? <p className="crews-note">{t('crews.page.none')}</p> : null}
      {state.kind === 'ready' && state.crews.length > 0 ? (
        <ul className="crews-list" aria-label={t('crews.page.saved')}>
          {state.crews.map((crew) => (
            <li key={crew.slug} className="crews-row" data-testid="crew-row">
              <span className="crews-row-name">{crew.name}</span>
              <span className="crews-row-meta">
                {t('crews.page.roles', { count: crew.roles })}
                {crew.agents.length > 0 ? ` · ${crew.agents.join(', ')}` : ''}
              </span>
              {crew.problem ? <span className="crews-row-problem">{t('crews.page.problem', { why: crew.problem })}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
