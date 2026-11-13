// The one-line mark of a slim sidebar row: the agent's own icon (brand logo or monogram) with a small status badge
// on its corner. Working = a thin spinner badge, needs you = a filled dot with a halo, error = a ring with a bar,
// idle = the icon alone, a little dimmer, ended = the icon faded. The state is also spoken (role img).
import { AgentLogo } from '../common/AgentLogo';

const LABEL: Record<string, string> = { running: 'Working', waiting_input: 'Needs you', idle: 'Idle', error: 'Error' };

export function RowMark({
  status,
  asking = false,
  agentId,
  agentName,
}: {
  status: string;
  asking?: boolean;
  /** The agent whose icon leads the row. Without it the mark is the plain status shape, as before. */
  agentId?: string;
  agentName?: string;
}) {
  const kind = asking ? 'needs' : status === 'running' ? 'working' : status === 'waiting_input' ? 'needs' : status === 'idle' ? 'idle' : status === 'error' ? 'error' : 'ended';
  const label = asking ? 'Needs you' : (LABEL[status] ?? 'Ended');
  if (!agentId) {
    return (
      <span className={`ck-mark ck-mark--${kind}`} role="img" aria-label={label}>
        <span className="ck-mark-shape" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className={`ck-mark ck-mark--${kind} ck-mark--icon`} role="img" aria-label={label}>
      <span className="ck-mark-agent" aria-hidden="true">
        <AgentLogo id={agentId} name={agentName} size={14} decorative />
      </span>
      {kind !== 'idle' && kind !== 'ended' && <span className="ck-mark-shape" aria-hidden="true" />}
    </span>
  );
}
