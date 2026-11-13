// "Bring my chats", step 1: the agents that keep chats on this PC, with a count each. An agent with none says so.
// Names, counts and folders come from the data the app sends; nothing here names an agent.
import { t, useT } from '../../i18n';
import { agoText } from '../../lib/bringChats';
import { chatCount, type ImportAgent, type ImportFound } from '../../lib/chatImport';

/** How an agent stands on this PC, from the agent health check. Anything else is `unknown`. */
export type AgentStanding = 'not_installed' | 'signed_out' | 'unknown';

/** The one plain reason an agent has nothing to bring. Not installed and signed out win over "no chats". */
export function missingReason(standing: AgentStanding, readable: boolean): string {
  if (standing === 'not_installed') return t('bring.notInstalled');
  if (standing === 'signed_out') return t('bring.signedOut');
  return t(readable ? 'bring.noChats' : 'bring.cantRead');
}

export function BringAgentList({
  found,
  unreadable,
  now,
  onPick,
  standing = () => 'unknown',
}: {
  found: ImportFound[];
  /** Installed agents that have no reader for their chats. */
  unreadable: ImportAgent[];
  now: number;
  onPick: (id: string) => void;
  /** How each agent stands (installed, signed in); a missing agent says why. */
  standing?: (id: string) => AgentStanding;
}) {
  useT(); // re-render when the language changes
  return (
    <ul className="bc-agents" aria-label="Agents">
      {found.map((agent) => {
        const empty = agent.chats === 0;
        const reason = missingReason(standing(agent.id), true);
        return (
          <li key={agent.id}>
            <button type="button" className="bc-agent-pick" disabled={empty} onClick={() => onPick(agent.id)}>
              <span className="bc-agent-main">
                <span className="bc-agent-name">
                  {empty ? agent.label : `${agent.label} · ${chatCount(agent.chats)}`}
                </span>
                {!empty && agent.newestMs !== null && <span className="bc-agent-sub">Newest chat {agoText(agent.newestMs, now)}</span>}
                {empty && <span className="bc-agent-sub">{reason}</span>}
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
            <div className="bc-agent-sub">{missingReason(standing(agent.id), false)}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
