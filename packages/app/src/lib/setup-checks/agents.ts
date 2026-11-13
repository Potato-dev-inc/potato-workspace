// Agents: one row per installed agent, from the same health check the Agent Doctor uses (`agents_health`).
// Every sentence names the agent, and a row that can be acted on carries its button: Sign in, Test or Try again.
import { t } from '../../i18n';
import type { AgentHealth } from '../agent-health';
import type { CheckRow } from './types';

/** "Found it, but it did not start properly: exit code 1" becomes "Codex was found but did not start (exit code 1)". */
function didNotStart(a: AgentHealth): string {
  const detail = /did not start properly:?\s*(.*)$/i.exec(a.reason)?.[1]?.trim().replace(/\.$/, '');
  if (detail !== undefined) return detail ? t('overview.check.agent.didNotStartWhy', { label: a.label, detail }) : t('overview.check.agent.didNotStart', { label: a.label });
  return a.reason || t('overview.check.agent.problem', { label: a.label });
}

export function checkAgents(agents: AgentHealth[]): CheckRow[] {
  return agents
    .filter((a) => a.installed)
    .map((a): CheckRow => {
      if (a.state === 'ready') return { id: `agent-${a.id}`, status: 'ok', sentence: t('overview.check.agent.ready', { label: a.label }), fix: null };
      if (a.state === 'needs_login') {
        return {
          id: `agent-${a.id}`,
          status: 'warn',
          sentence: t('overview.check.agent.needsLogin', { label: a.label }),
          fix: { kind: 'signin', label: t('overview.fix.signIn'), agentId: a.id },
        };
      }
      if (a.state === 'error') {
        return { id: `agent-${a.id}`, status: 'fail', sentence: didNotStart(a), fix: a.can_test ? { kind: 'test', label: t('overview.fix.tryAgain'), agentId: a.id } : null };
      }
      return {
        id: `agent-${a.id}`,
        status: 'warn',
        sentence: t('overview.check.agent.notTested', { label: a.label }),
        fix: a.can_test ? { kind: 'test', label: t('overview.fix.test'), agentId: a.id } : null,
      };
    });
}
