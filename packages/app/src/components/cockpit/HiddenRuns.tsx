// Inbox info cards for helpers that ran with no pane ("Claude helper ran with no window: <task>"). A visible helper
// is a pane in the sidebar and needs no card. The cards block nothing, so they do not count toward "things need you".
import { useT } from '../../i18n';
import { hiddenRunState, tauriHiddenRunsApi, useHiddenRuns, type HiddenRunsApi } from '../../lib/hiddenRuns';
import { CardButton, InboxCard } from './InboxCard';

/** "claude" -> "Claude"; the app calls every agent by its plain name. */
function agentName(id: string, label?: (id: string) => string | undefined): string {
  const named = label?.(id);
  if (named) return named;
  const spaced = id.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function HiddenRuns({
  api = tauriHiddenRunsApi,
  agentLabel,
}: {
  api?: HiddenRunsApi;
  /** The agent's display name when the cockpit knows it. */
  agentLabel?: (id: string) => string | undefined;
}) {
  const t = useT();
  const { runs, dismiss } = useHiddenRuns(api);
  if (runs.length === 0) return null;
  return (
    <ul className="ib-list" aria-label={t('inboxCards.hidden.listLabel')}>
      {runs.map((run) => (
        <li key={run.handle}>
          <InboxCard
            kind="note"
            glyph={run.status === 'running' ? 'working' : run.status === 'failed' ? 'error' : 'notice'}
            info
            title={t('inboxCards.hidden.title', { name: agentName(run.agent_type, agentLabel) })}
            reason={<span className="ib-oneline">{run.task}</span>}
            status={hiddenRunState(run)}
            data={{ 'data-testid': 'hidden-run', 'data-status': run.status }}
            more={
              <CardButton tone="plain" role="dismiss" onClick={() => dismiss(run.handle)}>
                {t('inboxCards.dismiss')}
              </CardButton>
            }
          />
        </li>
      ))}
    </ul>
  );
}
