// Harness fixtures for Settings > Agents > Add an agent: the mocked `add_agent_*` and `agents_detect_installed` commands answer
// with one frame of a mock scenario (lib/addAgent.mocks.ts), so each screen of the box can be shot without a backend.
import type { FoundAgent } from '../lib/addAgent';
import { SCENARIOS } from '../lib/addAgent.mocks';
import type { HarnessDom } from './types';

export interface AddAgentHarness {
  /** A key of SCENARIOS. */
  scenario: string;
  /** Which frame `add_agent_start` answers with: an index, or the last one (default). */
  frame?: number | 'last' | 'install';
  /** What `agents_detect_installed` lists; absent: the command fails, so the section stays hidden. */
  found?: FoundAgent[];
}

export const FOUND_ON_THIS_PC: FoundAgent[] = [
  { id: 'claude', displayName: 'Claude', path: 'C:/tools/claude.exe', kind: 'native', version: '2.1.4' },
  { id: 'codex', displayName: 'Codex', path: 'C:/tools/codex.exe', kind: 'native', version: '0.162.1' },
];

export function addAgentMock(cfg: AddAgentHarness | undefined, cmd: string, a: Record<string, unknown>): { handled: boolean; value?: unknown } {
  if (!cfg) return { handled: false };
  const frames = SCENARIOS[cfg.scenario]?.frames ?? [];
  const pick = cfg.frame === 'install' ? frames.findIndex((f) => f.run.state === 'needs_install') : cfg.frame === undefined || cfg.frame === 'last' ? frames.length - 1 : cfg.frame;
  const frame = frames[Math.max(0, Math.min(pick, frames.length - 1))]?.run;
  switch (cmd) {
    case 'add_agent_start':
      return { handled: true, value: frame ? { ...frame, input: String(a.input ?? frame.input) } : null };
    case 'add_agent_status':
      return { handled: true, value: null };
    case 'add_agent_cancel':
    case 'add_agent_approve_install':
      return { handled: true, value: frame };
    case 'agents_detect_installed':
      if (cfg.found) return { handled: true, value: cfg.found };
      throw new Error('no such command');
    default:
      return { handled: false };
  }
}

/** Types into the box and presses Add, as a person would. */
export async function typeAndAdd(dom: HarnessDom, text: string): Promise<void> {
  const input = (await dom.waitFor('input[aria-label="Agent name"]')) as HTMLInputElement | null;
  if (!input) return;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await dom.sleep(100);
  await dom.click('.aa-form button[type="submit"]');
  await dom.sleep(400);
}
