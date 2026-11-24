// The top line of the right panel (sticks while the panel scrolls): the agent's logo and name, and a state pill. A
// helper pane also shows "Helper of X" (opens the parent). When the agent waits on the person, one orange row
// under the line says what it asks and takes them to the question.
import { useT } from '../../../i18n';
import { AgentLogo } from '../../common/AgentLogo';

export type RailState = 'working' | 'needs' | 'done' | 'ready' | 'stopped' | 'away' | 'ended';

/** The pill's state from the pane's status; `fresh` is a chat with no turns yet. */
export function railState(status: string, fresh: boolean, ended = false): RailState {
  // A far chat that ended while its PC was off: grey "Ended", not a red "Stopped".
  if (ended) return 'ended';
  if (status === 'running') return 'working';
  if (status === 'waiting_input') return 'needs';
  if (status === 'error' || status === 'exited') return 'stopped';
  if (status === 'away') return 'away';
  return fresh ? 'ready' : 'done';
}

export function RailTop({
  agentType,
  agentName,
  title,
  tip,
  state,
  helperOf,
  onOpenParent,
  ask,
  onAnswer,
}: {
  agentType: string;
  agentName: string;
  /** The chat's own name when the person renamed it; shown instead of the agent name. */
  title?: string;
  /** Model, version and account: shown when the name is hovered. */
  tip?: string;
  state: RailState;
  helperOf: { parentId: string; text: string } | null;
  onOpenParent: (id: string) => void;
  /** What the agent asks, in one line; null when it is not asking. */
  ask: string | null;
  onAnswer: () => void;
}) {
  const t = useT();
  return (
    <>
      <div className="rp-top" data-testid="rail-top">
        <AgentLogo id={agentType} name={agentName} size={16} decorative />
        <b title={tip}>{title || agentName}</b>
        <span className={`rp-pill is-${state}`} data-testid="rail-pill">
          {(state === 'working' || state === 'needs') && <span className={`rp-dot is-${state}`} aria-hidden="true" />}
          {state === 'ended' ? t('r21fn.ended.word') : t(`rail.state.${state}` as 'rail.state.working')}
        </span>
      </div>
      {helperOf && (
        <button type="button" className="rp-helper-of" title={t('rail.helperOpen')} onClick={() => onOpenParent(helperOf.parentId)}>
          {helperOf.text}
        </button>
      )}
      {state === 'needs' && ask && (
        <button type="button" className="rp-need" data-testid="rail-needs-you" onClick={onAnswer}>
          <span className="rp-dot is-needs" aria-hidden="true" />
          <span className="rp-t">{ask}</span>
          <span className="rp-go">{t('rail.needs.answer')}</span>
        </button>
      )}
    </>
  );
}
