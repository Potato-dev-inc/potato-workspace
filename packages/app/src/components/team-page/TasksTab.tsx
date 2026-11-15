import { useT } from '../../i18n';
import type { TeamApi, TeamState } from '../../lib/team';
import { TeamCard } from '../cockpit/team/TeamCard';
import { tasksForMe } from './team-page-model';

/**
 * Tasks. Today these are the review requests and notes your teammates sent (their heads-up cards). Passing a task to a
 * teammate is not built yet. A teammate's text is untrusted: the cards show it as plain, quoted text and run nothing.
 */
export function TasksTab({ state, api, now, onDone }: { state: TeamState; api: TeamApi; now: number; onDone: () => void }) {
  const t = useT();
  const mine = tasksForMe(state.cards);
  if (mine.length === 0) {
    return (
      <p className="tpg-sub tpg-empty" data-testid="tasks-empty">
        {t('teamHub.tasks.empty')}
      </p>
    );
  }
  return (
    <div className="tpg-tasks">
      <section aria-label={t('teamHub.tasks.forYou')}>
        <h3 className="tpg-h">{t('teamHub.tasks.forYou')}</h3>
        <ul className="ib-list">
          {mine.map((card) => (
            <li key={card.id}>
              <TeamCard card={card} api={api} now={now} onDone={onDone} />
            </li>
          ))}
        </ul>
      </section>
      <section aria-label={t('teamHub.tasks.passed')}>
        <h3 className="tpg-h">{t('teamHub.tasks.passed')}</h3>
        <p className="tpg-sub">{t('teamHub.tasks.nonePassed')}</p>
      </section>
    </div>
  );
}
