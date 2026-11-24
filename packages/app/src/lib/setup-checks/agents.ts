// Agents: one row per installed agent, from the same health check the Agent Doctor uses (`agents_health`).
// Every sentence names the agent, and a row that can be acted on carries its button: Sign in, Test or Try again.
import { t } from '../../i18n';
import type { AgentHealth } from '../agent-health';
import { agentReadiness } from '../agentReadiness';
import type { OwnLogin } from '../../components/settings/agents/ownSignIn';
import type { CheckRow } from './types';
import { timeOf, type TestMemory } from './test-memory';

/** "Found it, but it did not start properly: exit code 1" becomes "Codex was found but did not start (exit code 1)". */
function didNotStart(a: AgentHealth): string {
  const detail = /did not start properly:?\s*(.*)$/i.exec(a.reason)?.[1]?.trim().replace(/\.$/, '');
  if (detail !== undefined) return detail ? t('overview.check.agent.didNotStartWhy', { label: a.label, detail }) : t('overview.check.agent.didNotStart', { label: a.label });
  return a.reason || t('overview.check.agent.problem', { label: a.label });
}

/** One row per agent: installed ones first (ready, sign in, test), then a quiet "not installed" row each. The words come from `agentReadiness`, the one truth the Agents cards share. */
export function checkAgents(agents: AgentHealth[], remembered: TestMemory = {}, logins: OwnLogin[] | null = null): CheckRow[] {
  const installed = agents
    .filter((a) => a.installed)
    .map((a): CheckRow => {
      const id = `agent-${a.id}`;
      const r = agentReadiness(a.id, { health: agents, logins, tests: remembered });
      const when = r.at ? timeOf(r.at) : '';
      const test = a.can_test ? ({ kind: 'test', label: t('overview.fix.test'), agentId: a.id } as const) : null;
      switch (r.state) {
        case 'broken':
          return r.at
            ? { id, status: 'fail', sentence: t('overview.check.agent.testFailed', { label: a.label, why: (r.reason ?? '').replace(/\.$/, ''), time: when }), fix: { kind: 'test', label: t('overview.fix.tryAgain'), agentId: a.id } }
            : { id, status: 'fail', sentence: didNotStart(a), fix: a.can_test ? { kind: 'test', label: t('overview.fix.tryAgain'), agentId: a.id } : null };
        case 'ready':
          return r.at
            ? { id, status: 'ok', sentence: t('overview.check.agent.testedOk', { label: a.label, time: when }), fix: { kind: 'test', label: t('overview.fix.testAgain'), agentId: a.id } }
            : { id, status: 'ok', sentence: t('overview.check.agent.cannotTest', { label: a.label }), fix: { kind: 'open', label: t('overview.fix.open'), agentId: a.id } };
        case 'signed_in':
          return { id, status: 'ok', sentence: t('overview.check.agent.ready', { label: a.label }), fix: null };
        case 'needs_sign_in':
          return { id, status: 'warn', sentence: r.at ? t('overview.check.agent.needsLoginAt', { label: a.label, time: when }) : t('overview.check.agent.needsLogin', { label: a.label }), fix: { kind: 'signin', label: t('overview.fix.signIn'), agentId: a.id } };
        default:
          return { id, status: 'warn', sentence: t('overview.check.agent.notTested', { label: a.label }), fix: test };
      }
    });
  const missing = agents
    .filter((a) => !a.installed)
    .map((a): CheckRow => ({
      // A different id prefix: "not installed" is never counted as an agent that is set up or a problem.
      id: `agentoff-${a.id}`,
      status: 'quiet',
      sentence: t('overview.check.agent.notInstalled', { label: a.label }),
      fix: { kind: 'install', label: t('overview.fix.install'), agentId: a.id },
    }));
  return [...installed, ...missing];
}
