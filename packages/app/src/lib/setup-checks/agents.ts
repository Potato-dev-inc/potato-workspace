// Agents: one row per installed agent, from the same health check the Agent Doctor uses (`agents_health`).
// Every sentence names the agent, and a row that can be acted on carries its button: Sign in, Test or Try again.
import type { AgentHealth } from '../agent-health';
import type { CheckRow } from './types';

/** "Found it, but it did not start properly: exit code 1" becomes "Codex was found but did not start (exit code 1)". */
function didNotStart(a: AgentHealth): string {
  const detail = /did not start properly:?\s*(.*)$/i.exec(a.reason)?.[1]?.trim().replace(/\.$/, '');
  if (detail !== undefined) return detail ? `${a.label} was found but did not start (${detail})` : `${a.label} was found but did not start`;
  return a.reason || `${a.label} has a problem`;
}

export function checkAgents(agents: AgentHealth[]): CheckRow[] {
  return agents
    .filter((a) => a.installed)
    .map((a): CheckRow => {
      if (a.state === 'ready') return { id: `agent-${a.id}`, status: 'ok', sentence: `${a.label} is signed in`, fix: null };
      if (a.state === 'needs_login') {
        return {
          id: `agent-${a.id}`,
          status: 'warn',
          sentence: `${a.label} needs sign-in`,
          fix: { kind: 'signin', label: 'Sign in', agentId: a.id },
        };
      }
      if (a.state === 'error') {
        return { id: `agent-${a.id}`, status: 'fail', sentence: didNotStart(a), fix: a.can_test ? { kind: 'test', label: 'Try again', agentId: a.id } : null };
      }
      return {
        id: `agent-${a.id}`,
        status: 'warn',
        sentence: `${a.label} is not tested yet`,
        fix: a.can_test ? { kind: 'test', label: 'Test', agentId: a.id } : null,
      };
    });
}
