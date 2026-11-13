// What the last "Test" said about each agent, kept on this computer so the list is not "not tested yet" on every open.
// Only the plain result is kept (state, one sentence, when): never a prompt, an answer or a login.
import type { AgentHealth, HealthState } from '../agent-health';

export interface RememberedTest {
  state: HealthState;
  reason: string;
  /** Epoch milliseconds. */
  at: number;
}
export type TestMemory = Record<string, RememberedTest>;

const KEY = 'pm.setupcheck.tests.v1';

export function loadTestMemory(): TestMemory {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as TestMemory) : {};
  } catch {
    return {};
  }
}

/** Keeps the answer of one Test. Storage that is blocked just means it is not remembered. */
export function rememberTest(result: AgentHealth, at = Date.now()): void {
  if (!result.id) return;
  try {
    const next = { ...loadTestMemory(), [result.id]: { state: result.state, reason: result.reason, at } };
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

/** "14:05" in the person's language. */
export function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
