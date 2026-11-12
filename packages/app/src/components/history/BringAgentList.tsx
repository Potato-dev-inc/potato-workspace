// "Bring my chats", step 1: the agents that keep chats on this PC, with a count each. An agent with none says so.
// Names, counts and folders come from the data the app sends; nothing here names an agent.
import { agoText } from '../../lib/bringChats';
import { chatCount, type ImportAgent, type ImportFound } from '../../lib/chatImport';

export function BringAgentList({
  found,
  unreadable,
  now,
  onPick,
}: {
  found: ImportFound[];
  /** Installed agents that have no reader for their chats. */
  unreadable: ImportAgent[];
  now: number;
  onPick: (id: string) => void;
}) {
  return (
    <ul className="bc-agents" aria-label="Agents">
      {found.map((agent) => {
        const empty = agent.chats === 0;
        return (
          <li key={agent.id}>
            <button type="button" className="bc-agent-pick" disabled={empty} onClick={() => onPick(agent.id)}>
              <span className="bc-agent-main">
                <span className="bc-agent-name">
                  {empty ? agent.label : `${agent.label} · ${chatCount(agent.chats)}`}
                </span>
                {!empty && agent.newestMs !== null && <span className="bc-agent-sub">Newest chat {agoText(agent.newestMs, now)}</span>}
                {empty && <span className="bc-agent-sub">No chats found on this PC</span>}
                {agent.fromDefinition && <span className="bc-agent-sub">From your agent definition</span>}
              </span>
              {!empty && <span aria-hidden="true">›</span>}
            </button>
          </li>
        );
      })}
      {unreadable.map((agent) => (
        <li key={agent.id} className="bc-agent is-off">
          <div className="bc-agent-main">
            <div className="bc-agent-name">{agent.label}</div>
            <div className="bc-agent-sub">This agent's chats can't be read yet</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
