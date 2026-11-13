// The one-line mark of a slim sidebar row: one mark, two readings. The brand icon says who (the agent); a small dot on
// its corner says what: green and breathing while it works, orange when it needs you, red when it is broken, and
// nothing when idle (the icon dims instead). The state is also spoken (role img) and the row's right side repeats it in words.
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
