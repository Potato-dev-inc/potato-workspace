// Answers the result buttons of Settings > Agents > Add an agent: "Start a chat" starts a chat session in the project
// folder, "Open in a terminal" opens the agent's own terminal pane. Both select the new pane, which leaves Settings.
// Renders nothing. Mounted once in the cockpit window.
import { useEffect, useRef } from 'react';
import type { CockpitApi } from '../../hooks/useCockpit';
import { useProjectPath } from '../../hooks/useProjectPath';
import { clearAddAgentActionRequest, registerAddAgentActionHost, useAddAgentActionRequest } from '../../lib/addAgentActions';
import { errorSentence } from '../../lib/sayError';
import { startChatSession } from './newagent/start';

type Host = Pick<CockpitApi, 'newAgent' | 'select' | 'notify'>;

export function AddAgentActionHost({
  c,
  folder,
  startChat = startChatSession,
}: {
  c: Host;
  /** The project folder for a chat; absent: read from the saved project folder. */
  folder?: string | null;
  startChat?: (agentId: string, folder: string) => Promise<string>;
}) {
  const request = useAddAgentActionRequest();
  const { projectPath } = useProjectPath();
  const cRef = useRef(c);
  cRef.current = c;
  const working = useRef<number | null>(null);

  useEffect(() => registerAddAgentActionHost(), []);

  useEffect(() => {
    if (!request || working.current === request.nonce) return;
    working.current = request.nonce;
    const { kind, agentId } = request;
    clearAddAgentActionRequest(request);
    const host = cRef.current;
    void (async () => {
      try {
        if (kind === 'chat') {
          const where = folder ?? projectPath;
          if (!where) {
            host.notify('Pick a project folder first (Settings > General), then start the chat.');
            return;
          }
          host.select(await startChat(agentId, where));
        } else {
          const paneId = await host.newAgent(agentId);
          if (paneId) host.select(paneId);
        }
      } catch (e) {
        host.notify(errorSentence(e));
      }
    })();
  }, [request, folder, projectPath, startChat]);

  return null;
}
