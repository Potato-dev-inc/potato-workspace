// What the last "Test" said about each agent, kept on this computer so the list is not "not tested yet" on every open.
// Only the plain result is kept (state, one sentence, when): never a prompt, an answer or a login.
import { getLanguage } from '../../i18n';
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

/** "2:05 PM", or "下午 2:05" in Traditional Chinese: the time in the language the app shows, not the computer's. */
export function timeOf(at: number): string {
  const date = new Date(at);
  if (getLanguage() !== 'zh-TW') return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // zh-TW writes the part of the day first and puts a space between it and the digits.
  return date.toLocaleTimeString('zh-TW', { hour: 'numeric', minute: '2-digit' }).replace(/^(\D+?)(\d)/, '$1 $2');
}
