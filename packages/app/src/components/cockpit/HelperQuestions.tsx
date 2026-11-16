// The questions of a pane's helpers, under its Chat: one compact card per helper that waits on a choice,
// "Codex helper asks: Pick a colour". It is the Inbox's own card (PaneApprovalCard): the same choices, the
// same answer route (`c.answer` with the prompt's id, so a stale card is refused) and the person's click as
// the typing permit. The Inbox lists the item once; this is a second place to answer it, and it leaves with it.
import type { CockpitApi } from '../../hooks/useCockpit';
import { useT } from '../../i18n';
import { helperAsksLabel, helpersAskingFor, isMinion } from '../../lib/helper-questions';
import { liveParentId } from '../../lib/pane-helpers';
import { PaneApprovalCard } from './PaneApprovalCard';
import { QuestionCard } from './QuestionCard';

/** A risky ask of a chat session that an agent started as a minion: the app raised a question for it (a chat session has no screen prompt). */
function minionQuestionOf(c: CockpitApi, id: string) {
  if (!isMinion(c.registry.panes.get(id)?.info)) return undefined;
  return c.asked.questions.find((q) => q.pane_id === id && q.kind === 'acp_permission' && q.state === 'pending' && q.choices.length > 0);
}

/** The helpers of `paneId` that wait on a card with choices right now. */
export function helperQuestionIds(c: CockpitApi, paneId: string): string[] {
  const asking = (id: string) => (c.registry.panes.get(id)?.status === 'waiting_input' && (c.prompts[id]?.choices.length ?? 0) > 0) || !!minionQuestionOf(c, id);
  return helpersAskingFor(c.registry.paneList, paneId, asking);
}

export function HelperQuestions({ c, ids }: { c: CockpitApi; ids: string[] }) {
  const t = useT();
  if (ids.length === 0) return null;
  return (
    <div className="ck-dock ck-helper-asks">
      {ids.map((id) => {
        const pane = c.registry.panes.get(id);
        const agent = c.names.get(id) ?? pane?.info.agent_type ?? 'Agent';
        // A minion's card is only here when its ask is risky (the app keeps an ordinary ask from the person): the lead-in
        // says whose minion it is, and the button shows what it is doing.
        const minion = isMinion(pane?.info);
        const parentId = minion ? liveParentId(c.registry.paneList, id) : null;
        const parent = (parentId && c.names.get(parentId)) || t('phone.dock.aParent');
        const question = c.prompts[id]?.choices.length ? undefined : minionQuestionOf(c, id);
        if (question) {
          return (
            <div key={`${id}:${question.id}`} className="ib-dock" role="group" aria-label={t('inboxCards.minionAsks', { parent })}>
              <p className="ck-helper-asks-lead">{t('inboxCards.minionAsks', { parent })}</p>
              <QuestionCard
                q={question}
                paneName={agent}
                now={c.now}
                onAnswer={(a) => void c.asked.answerQuestion(question.id, a)}
                onDismiss={() => void c.asked.dismissQuestion(question.id)}
                onOpenPane={() => c.select(id)}
              />
            </div>
          );
        }
        return (
          // The prompt's id is in the key: a new question from the same helper is a new card, never the old one reused.
          <div key={`${id}:${c.prompts[id]?.promptId}`} className="ib-dock" role="group" aria-label={minion ? t('inboxCards.minionAsks', { parent }) : `${agent} helper question`}>
            <PaneApprovalCard c={c} paneId={id} autoFocus={false} asks={minion ? t('inboxCards.minionAsks', { parent }) : helperAsksLabel(agent)} openLabel={minion ? t('inboxCards.openMinion') : t('phone.dock.openHelper')} onOpen={() => c.select(id)} />
          </div>
        );
      })}
    </div>
  );
}
