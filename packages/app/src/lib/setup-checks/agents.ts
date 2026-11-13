// Agents: one row per installed agent, from the same health check the Agent Doctor uses (`agents_health`).
// Every sentence names the agent, and a row that can be acted on carries its button: Sign in, Test or Try again.
import { t } from '../../i18n';
import type { AgentHealth } from '../agent-health';
import type { CheckRow } from './types';
import { timeOf, type TestMemory } from './test-memory';

/** "Found it, but it did not start properly: exit code 1" becomes "Codex was found but did not start (exit code 1)". */
function didNotStart(a: AgentHealth): string {
  const detail = /did not start properly:?\s*(.*)$/i.exec(a.reason)?.[1]?.trim().replace(/\.$/, '');
  if (detail !== undefined) return detail ? t('overview.check.agent.didNotStartWhy', { label: a.label, detail }) : t('overview.check.agent.didNotStart', { label: a.label });
  return a.reason || t('overview.check.agent.problem', { label: a.label });
}

/** The row of an agent that is installed but has not answered a quick check as ready: from its last Test, if any. */
function installedRow(a: AgentHealth, last: TestMemory[string] | undefined): CheckRow {
  const id = `agent-${a.id}`;
  const when = last ? timeOf(last.at) : '';
  if (last?.state === 'ready') {
    return { id, status: 'ok', sentence: t('overview.check.agent.testedOk', { label: a.label, time: when }), fix: { kind: 'test', label: t('overview.fix.testAgain'), agentId: a.id } };
  }
  if (last?.state === 'needs_login') {
    return { id, status: 'warn', sentence: t('overview.check.agent.needsLoginAt', { label: a.label, time: when }), fix: { kind: 'signin', label: t('overview.fix.signIn'), agentId: a.id } };
  }
  if (last?.state === 'error') {
    return { id, status: 'fail', sentence: t('overview.check.agent.testFailed', { label: a.label, why: last.reason.replace(/\.$/, ''), time: when }), fix: { kind: 'test', label: t('overview.fix.tryAgain'), agentId: a.id } };
  }
  if (a.can_test) {
    return { id, status: 'warn', sentence: t('overview.check.agent.notTested', { label: a.label }), fix: { kind: 'test', label: t('overview.fix.test'), agentId: a.id } };
  }
  // Found and it starts, but it cannot be asked a question for you: say so and offer to open it.
  return { id, status: 'ok', sentence: t('overview.check.agent.cannotTest', { label: a.label }), fix: { kind: 'open', label: t('overview.fix.open'), agentId: a.id } };
}

/** One row per agent: installed ones first (ready, sign in, test), then a quiet "not installed" row each. */
export function checkAgents(agents: AgentHealth[], remembered: TestMemory = {}): CheckRow[] {
  const installed = agents
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
      return installedRow(a, remembered[a.id]);
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
