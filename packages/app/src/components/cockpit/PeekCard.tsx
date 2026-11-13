// The peek card on a sidebar agent row: rest the pointer on the row (about 400 ms) or press Space on a focused
// row. It shows the current step, time running, files changed, usage, the last line, the plan progress and, when the
// agent waits, its question (low-risk yes/no answers can be given right here). Buttons: Open to the side, Stop.
// It never takes focus, closes when the pointer leaves, and has no motion when the person asked for less.
import { useEffect, useState, type MouseEvent } from 'react';
import { useT } from '../../i18n';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { TurnSummary } from '../../lib/cockpit-api';
import { paneUsage, type PaneUsage } from '../../lib/pane-usage';
import { usePlanProgress } from '../../lib/planProgress';
import { gestureOf } from '../../lib/user-gesture';
import { PlanLine } from '../common/PlanLine';
import { stateText } from './model';
import { peekModel } from './peek-model';
import '../../styles/cockpit-peek.css';

export function PeekCard({
  c,
  paneId,
  title,
  lastTurn,
  onOpenToSide,
  onOpen,
  onClose,
  onHover,
}: {
  c: CockpitApi;
  paneId: string;
  title: string;
  lastTurn: TurnSummary | undefined;
  onOpenToSide?: (paneId: string) => void;
  /** Open the pane itself (to answer a question that is not a quick yes/no). */
  onOpen: (paneId: string) => void;
  onClose: () => void;
  /** The pointer is on the card (true) or left it (false): the row keeps it open while it is on. */
  onHover: (on: boolean) => void;
}) {
  const t = useT();
  const pane = c.registry.panes.get(paneId);
  const status = pane?.status ?? '';
  const [usage, setUsage] = useState<PaneUsage | null>(null);
  useEffect(() => {
    let live = true;
    paneUsage(paneId).then(
      (u) => live && setUsage(u),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [paneId]);
  const plan = usePlanProgress(paneId);
  if (!pane) return null;

  const model = peekModel({ status, activity: c.activities?.[paneId], since: c.statusSince.get(paneId), now: c.now, lastTurn, usage, prompt: c.prompts[paneId] });
  const answer = (event: MouseEvent<HTMLButtonElement>, choice: { id: string; label: string }) => {
    if (!model.question) return;
    void c.answer(paneId, model.question.promptId, choice.id, choice.label, gestureOf(event));
    onClose();
  };

  return (
    <div
      className="ck-peek"
      role="group"
      aria-label={t('peek.label', { name: title })}
      data-testid="peek-card"
      data-pane-id={paneId}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      <div className="ck-peek-head">
        <span className="ck-peek-name">{title}</span>
        <span className="ck-peek-state">{stateText(status)}</span>
      </div>
      {plan && (
        <div className="ck-peek-plan">
          <PlanLine paneId={paneId} />
          <span>{t('peek.plan', { done: plan.done, total: plan.total })}</span>
        </div>
      )}
      <dl className="ck-peek-facts">
        {model.step && (
          <div>
            <dt>{t('peek.now')}</dt>
            <dd>{model.step}</dd>
          </div>
        )}
        {model.running && (
          <div>
            <dt>{t('peek.running')}</dt>
            <dd>{model.running}</dd>
          </div>
        )}
        {model.files !== null && (
          <div>
            <dd>{t('peek.files', { count: model.files })}</dd>
          </div>
        )}
        {model.usage && (
          <div>
            <dd>{t('peek.usage', { count: model.usage.turns, time: model.usage.time })}</dd>
          </div>
        )}
        {model.lastLine && (
          <div>
            <dt>{t('peek.last')}</dt>
            <dd>{model.lastLine}</dd>
          </div>
        )}
      </dl>
      {model.empty && !plan && <p className="ck-peek-empty">{t('peek.nothing')}</p>}
      {model.question && (
        <div className="ck-peek-ask">
          <span className="ck-peek-ask-label">{t('peek.asking')}</span>
          <p>{model.question.text}</p>
          <div className="ck-peek-actions">
            {model.question.quick.length > 0 ? (
              model.question.quick.map((choice) => (
                <button key={choice.id} type="button" className="ck-btn ck-btn--secondary ck-btn--sm" onClick={(e) => answer(e, choice)}>
                  {choice.label}
                </button>
              ))
            ) : (
              <button
                type="button"
                className="ck-btn ck-btn--secondary ck-btn--sm"
                onClick={() => {
                  onOpen(paneId);
                  onClose();
                }}
              >
                {t('peek.openAnswer')}
              </button>
            )}
          </div>
        </div>
      )}
      <div className="ck-peek-actions">
        {onOpenToSide && (
          <button
            type="button"
            className="ck-btn ck-btn--secondary ck-btn--sm"
            onClick={() => {
              onOpenToSide(paneId);
              onClose();
            }}
          >
            {t('peek.openSide')}
          </button>
        )}
        {status === 'running' && (
          <button
            type="button"
            className="ck-btn ck-btn--plain ck-btn--sm"
            onClick={() => {
              void c.interrupt(paneId);
              onClose();
            }}
          >
            {t('peek.stop')}
          </button>
        )}
      </div>
    </div>
  );
}
