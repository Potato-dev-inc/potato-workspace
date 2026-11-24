// How ONE agent stands, said once. Every screen that tells a person whether an agent works (Overview rows, the Agents card header
// and its Sign-in row, Set up agents, the Agent Store, the New agent page, Welcome) asks this and shows its label, so two screens
// can never disagree. Nothing here sees a credential: it reads the install state, the quick health check, the login read
// (`agent_login_states`) and what the last Test said.
//
// Order of proof, strongest first: did not start / failed its Test; the login is gone (or its usage row says it ran out); the last Test
// works; a login that reads as signed in; a Test or the quick check that says "needs a sign-in"; else not checked yet.
import { t } from '../i18n';
import type { OwnLogin } from '../components/settings/agents/ownSignIn';
import type { AgentHealth } from './agent-health';
import type { TestMemory } from './setup-checks/test-memory';
import { timeOf } from './setup-checks/test-memory';
import type { UsageRow } from './usage';

export type ReadinessState = 'ready' | 'signed_in' | 'needs_sign_in' | 'not_checked' | 'broken' | 'not_installed';

export interface AgentReadiness {
  state: ReadinessState;
  /** The short phrase for a header or a chip. */
  label: string;
  /** One more line (when it was tested, why it could not be told, what went wrong), or null. */
  detail: string | null;
  /** When the Test that decided it ran (epoch ms), if one did. */
  at?: number;
  /** The reason the Test or the start gave, for a sentence that quotes it. */
  reason?: string;
}

export interface ReadinessSources {
  /** The quick health check. Absent or without this agent: the install state is not known. */
  health?: readonly Pick<AgentHealth, 'id' | 'label' | 'installed' | 'state' | 'reason' | 'can_test'>[];
  /** `agent_login_states`; null until it answered. */
  logins: readonly OwnLogin[] | null;
  /** What the last Test said per agent. */
  tests?: TestMemory;
  usage?: readonly UsageRow[];
}

const LABEL: Record<ReadinessState, () => string> = {
  ready: () => t('agentList.ready'),
  signed_in: () => t('agentCard.signedIn'),
  needs_sign_in: () => t('agentList.notSignedIn'),
  not_checked: () => t('linux.notChecked'),
  broken: () => t('r21fn.ready.failed'),
  not_installed: () => t('keepGoing.notInstalled'),
};

export function agentReadiness(agentId: string, src: ReadinessSources): AgentReadiness {
  const make = (state: ReadinessState, detail: string | null = null, extra: Partial<AgentReadiness> = {}): AgentReadiness => ({ state, label: LABEL[state](), detail, ...extra });
  const quick = src.health?.find((h) => h.id === agentId);
  if (quick && (!quick.installed || quick.state === 'not_installed')) return make('not_installed');
  const test = src.tests?.[agentId];
  const at = test?.at;
  const when = at ? t('r21fn.ready.testedAt', { time: timeOf(at) }) : null;
  // It did not start, or its last Test failed.
  if (quick?.state === 'error') return make('broken', quick.reason || null, { reason: quick.reason });
  if (test?.state === 'error') return make('broken', test.reason ? `${test.reason.replace(/\.$/, '')}. ${when}` : when, { at, reason: test.reason });
  // The login itself is gone, or its usage row says it ran out.
  const login = src.logins?.find((l) => l.agent_id === agentId);
  const expired = login?.state === 'signed_in' && src.usage?.some((u) => u.agent_id === agentId && u.account_id == null && !u.link && u.state === 'expired');
  if (login?.state === 'signed_out' || expired) return make('needs_sign_in', expired ? t('agentCard.expired') : null);
  if (test?.state === 'ready') return make('ready', when, { at });
  // A login that reads as signed in outranks an older "needs sign-in" (a Test from before it, or the quick check): it never flips back.
  if (login?.state === 'signed_in') return make('signed_in');
  if (test?.state === 'needs_login') return make('needs_sign_in', when, { at });
  if (quick?.state === 'needs_login') return make('needs_sign_in');
  // Found and it starts, but it cannot be asked a question for you.
  if (quick && quick.can_test === false) return make('ready', t('r21fn.ready.cannotTest'));
  // Not checked yet: say why the login could not be told, when that is the reason.
  const why = !login ? t(src.logins === null ? 'agentCard.notLooked' : 'agentCard.noWay', { label: quick?.label ?? agentId }) : (login.why ?? null);
  return make('not_checked', why);
}
