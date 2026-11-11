// The starting view for a chat (ACP) while its agent starts. Drawn in the same slot as the terminal's
// starting view (SpawnView): a chat-shaped skeleton, quiet and grey, so the person sees the chat at once.
import { agentLabel, useAgentRegistry } from '../../lib/agentRegistry';
import type { ChatStartState } from '../../hooks/useCockpit';
import { DotSpinner } from './DotSpinner';

/** The last part of a folder path, for a short label ("C:\\work\\shop" -> "shop"). */
function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function ChatStartingView({ start }: { start: ChatStartState }) {
  const listing = useAgentRegistry();
  const label = agentLabel(listing, start.agentId);

  return (
    <div className="ck-spawn ck-chat-start" role="status" aria-live="polite" data-testid="chat-starting">
      <div className="ck-spawn-glyph">
        <DotSpinner status="running" size={5} />
      </div>
      <h1 className="ck-title">Starting {label}</h1>
      <p className="ck-sub" title={start.folder}>
        {folderName(start.folder)}
      </p>
      <div className="ck-chat-start-body" aria-hidden="true">
        <div className="ck-chat-start-row ck-chat-start-row--short" />
        <div className="ck-chat-start-row" />
        <div className="ck-chat-start-row ck-chat-start-row--mid" />
      </div>
      <div className="ck-chat-start-composer" aria-hidden="true">
        Starting...
      </div>
    </div>
  );
}
