// Agent Store: search, filter chips and a grid of agent cards. Lists what the catalog ships; installing happens in the detail sheet.
// The grid only reads the list (agentStoreApi.list) and hands a card's button to onOpenAgent.
import { errorSentence } from '../../lib/sayError';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { t } from '../../i18n';
import { agentStoreApi, type AgentStoreApi, type StoreCard } from '../../lib/agent-store';
import { matchesFilter, searchCards, sortCards, STORE_FILTERS, type StoreFilter } from '../../lib/agent-store-model';
import { useAgentReadiness } from '../../lib/useAgentReadiness';
import { AgentStoreCard } from './AgentStoreCard';
import '../../styles/agent-store.css';

export interface AgentStoreProps {
  api?: AgentStoreApi;
  /** A card's button was pressed for this agent id. */
  onOpenAgent: (agentId: string) => void;
  onBack: () => void;
  /** Bump it to load the cards again (something changed in a sheet). The search and filter stay. */
  revision?: number;
}

/** The list is slow on a PC with many folders on PATH: say so after this long, and stop waiting after the second. */
export const SLOW_LOAD_MS = 6000;
export const GIVE_UP_LOAD_MS = 30000;

const errText = (e: unknown) => (errorSentence(e)).replace(/^[A-Z_]+: /, '');

export function AgentStore({ api = agentStoreApi, onOpenAgent, onBack, revision = 0 }: AgentStoreProps) {
  const readiness = useAgentReadiness();
  const [cards, setCards] = useState<StoreCard[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<StoreFilter>('all');
  const [waited, setWaited] = useState<'' | 'slow' | 'gaveUp'>('');

  useEffect(() => {
    if (cards || loadError) return undefined;
    setWaited('');
    const slow = setTimeout(() => setWaited('slow'), SLOW_LOAD_MS);
    const give = setTimeout(() => setWaited('gaveUp'), GIVE_UP_LOAD_MS);
    return () => {
      clearTimeout(slow);
      clearTimeout(give);
    };
  }, [cards, loadError, revision]);

  const load = useCallback(() => {
    setLoadError(null);
    api
      .list()
      .then((list) => setCards(list.entries))
      .catch((e) => setLoadError(errText(e)));
  }, [api]);

  // `revision` is not read in `load`: a new value is the host's way to ask for a fresh list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [load, revision]);

  const shown = useMemo(
    () => (cards ? sortCards(searchCards(cards.filter((card) => matchesFilter(card, filter)), text)) : []),
    [cards, filter, text],
  );

  return (
    <div className="ck-store">
      <header className="ck-store-head">
        <div>
          <h1 className="ck-title">{t('r21.sw.agentStore')}</h1>
          <p className="ck-sub">{t('r21.sw.agentsYouCanAdd')}</p>
        </div>
        <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" onClick={onBack}>
          Back
        </button>
      </header>

      <div className="ck-store-bar">
        <input
          type="search"
          className="ck-store-search"
          aria-label={t('r21.sw.searchAgents')}
          placeholder={t('r21.sw.searchAgents')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="ck-store-chips" role="group" aria-label="Filters">
          {STORE_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              className={filter === f.id ? 'is-on' : undefined}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {loadError && (
        <div className="ck-store-error" role="alert">
          <p>Could not load the Agent Store: {loadError}</p>
          <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" onClick={load}>
            Try again
          </button>
        </div>
      )}
      {!cards && !loadError && (
        <div aria-busy="true" role="status">
          <p className="ck-sub">{waited === 'gaveUp' ? t('store.loadTimeout') : waited === 'slow' ? t('store.loadSlow') : t('store.loading')}</p>
          {waited === 'gaveUp' && (
            <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" onClick={load}>
              Try again
            </button>
          )}
          <ul className="ck-store-grid" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <li key={n} className="ck-store-skel" />
            ))}
          </ul>
        </div>
      )}

      {cards && shown.length > 0 && (
        <ul className="ck-store-grid" aria-label="Agents">
          {shown.map((card) => (
            <li key={card.id}>
              <AgentStoreCard card={card} onOpen={onOpenAgent} standing={card.state === 'ready' ? readiness.of(card.id) : undefined} />
            </li>
          ))}
        </ul>
      )}
      {cards && shown.length === 0 && (
        <p className="ck-sub ck-store-empty">
          {cards.length === 0 ? 'The Store has no agents yet.' : 'No agents match. Try another word, or press All.'}
        </p>
      )}
    </div>
  );
}
