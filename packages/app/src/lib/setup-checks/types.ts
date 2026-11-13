// Shared shapes for "Check my setup". A check turns one status read into rows; a row is one plain sentence and at most
// one fix button. Checks never run a command themselves: they only call the `SetupCheckDeps` they are given.
import type { AddonList } from '../acpAddon';
import type { AgentHealth } from '../agent-health';
import type { TestMemory } from './test-memory';

/** `quiet`: nothing to do and nothing wrong (an agent that is not installed). It is never counted as a problem. */
export type CheckStatus = 'ok' | 'warn' | 'fail' | 'quiet';

/** What the one fix button does. The page maps each kind to an action (see `runFix`). */
export type FixKind = 'signin' | 'installAddon' | 'test' | 'install' | 'open';

export interface FixAction {
  kind: FixKind;
  label: string;
  /** Agent id for `signin`, `installAddon`, `test`, `install` and `open`. */
  agentId?: string;
}

export interface CheckRow {
  /** Stable id, used as the React key and in tests. */
  id: string;
  status: CheckStatus;
  /** One plain sentence. Shown as is, and copied as is into the report. */
  sentence: string;
  fix: FixAction | null;
}

/** The status reads the checks need. Defaults are the Tauri commands (see `index.ts`); tests pass fakes. */
export interface SetupCheckDeps {
  agentHealth: () => Promise<AgentHealth[]>;
  addons: () => Promise<AddonList>;
  /** What the last Test said per agent. Absent: nothing is remembered. */
  tests?: () => TestMemory;
}

/** Facts the page already has (from Settings), passed in so checks stay pure. */
export interface SetupCheckContext {
  bridgeUrl: string | null;
  /** Labs switches as saved in settings. */
  labs: Readonly<Record<string, boolean | undefined>>;
}
