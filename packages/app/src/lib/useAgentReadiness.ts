// The sources of `agentReadiness`, read once for a screen that has no list of its own (the Store, the New agent page): the quick health
// check, the login read and the kept Test results, at one place. A Test that finishes anywhere updates it (the kept results change).
import { useEffect, useMemo, useState } from 'react';
import { useHost } from './host/context';
import { agentHealthApiFor, type AgentHealth } from './agent-health';
import { agentReadiness, type AgentReadiness } from './agentReadiness';
import { loadTestMemory, TEST_MEMORY_EVENT, type TestMemory } from './setup-checks/test-memory';
import { ownLoginApiFor, type OwnLogin } from '../components/settings/agents/ownSignIn';

/** The kept Test results, read again whenever one is kept or forgotten. */
export function useTestMemory(): TestMemory {
  const [tests, setTests] = useState<TestMemory>(loadTestMemory);
  useEffect(() => {
    const read = () => setTests(loadTestMemory());
    window.addEventListener(TEST_MEMORY_EVENT, read);
    return () => window.removeEventListener(TEST_MEMORY_EVENT, read);
  }, []);
  return tests;
}

/** `of(agentId)` says how an agent stands at this place. Until the reads answer, an agent is "not checked yet". */
export function useAgentReadiness(): { of: (agentId: string) => AgentReadiness; ready: boolean } {
  const host = useHost();
  const tests = useTestMemory();
  const [health, setHealth] = useState<AgentHealth[] | undefined>();
  const [logins, setLogins] = useState<OwnLogin[] | null>(null);
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => agentHealthApiFor(host).check())
      .then((h) => live && setHealth(h), () => undefined);
    Promise.resolve()
      .then(() => ownLoginApiFor(host).states())
      .then((l) => live && setLogins(l), () => undefined);
    return () => {
      live = false;
    };
  }, [host]);
  return useMemo(() => ({ of: (id: string) => agentReadiness(id, { health, logins, tests }), ready: !!health }), [health, logins, tests]);
}
