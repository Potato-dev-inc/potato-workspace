// The quiet start-up check: a few seconds after the app opens, in the background, five things are looked at (agents signed in,
// the PC bridge, free disk space, the update channel, "Show terminals" against the agents the person has). When all is fine
// nothing shows. When one is wrong the cockpit shows ONE line with a Fix button, never a window that blocks. The agent
// rows reuse the code of "Check my setup", so the words and the fixes are the same.
import { invoke } from '@tauri-apps/api/core';
import { t } from '../i18n';
import { chatCapable, terminalChatCapable, type AcpLaneView } from './acpChat';
import { agentHealthApi, type AgentHealth } from './agent-health';
import { tauriUpdateTransport } from './app-update';
import { terminalsShown, type TerminalSwitchSettings } from './showTerminals';
import { checkAgents } from './setup-checks/agents';
import { isCantCheck } from './setup-checks';

/** Below this much free room the line shows (2 GB). */
export const LOW_DISK_BYTES = 2 * 1024 ** 3;

export type StartupFixKind = 'signin' | 'settings' | 'terminals';

export interface StartupFix {
  kind: StartupFixKind;
  label: string;
  agentId?: string;
  /** For `settings`: the page. */
  page?: 'overview' | 'agents' | 'connect';
}

export interface StartupLine {
  id: 'agents' | 'bridge' | 'disk' | 'update' | 'terminals';
  text: string;
  fix: StartupFix | null;
}

export interface StartupDeps {
  agentHealth: () => Promise<AgentHealth[]>;
  /** True while the PC bridge is connected. */
  bridgeUp: () => boolean;
  /** Free bytes on the app's drive, or null when unknown. */
  diskFreeBytes: () => Promise<number | null>;
  /** True when the update address answered; false when it did not. */
  updateReachable: () => Promise<boolean>;
  lanes: () => Promise<AcpLaneView | null>;
  settings: () => Promise<TerminalSwitchSettings | null>;
}

/** The checks, in the order their line would be shown. Each one that cannot read its answer says nothing. */
export async function runStartupCheck(deps: StartupDeps): Promise<StartupLine[]> {
  const lines: StartupLine[] = [];
  let health: AgentHealth[] = [];
  try {
    health = await deps.agentHealth();
  } catch {
    /* unreadable: no agent line, and no terminal line either */
    health = [];
  }

  // 1. An installed agent that is not signed in. The words come from "Check my setup".
  const signedOut = checkAgents(health).filter((r) => r.fix?.kind === 'signin' && r.status !== 'ok' && !isCantCheck(r.sentence));
  for (const row of signedOut) {
    lines.push({ id: 'agents', text: row.sentence, fix: { kind: 'signin', label: t('overview.fix.signIn'), agentId: row.fix?.agentId } });
  }

  // 2. The PC bridge.
  try {
    if (!deps.bridgeUp()) lines.push({ id: 'bridge', text: t('flow.startup.bridge'), fix: { kind: 'settings', label: t('flow.startup.checkSetup'), page: 'overview' } });
  } catch {
    /* unreadable: nothing to say */
  }

  // 3. Free disk space.
  try {
    const free = await deps.diskFreeBytes();
    if (free !== null && free < LOW_DISK_BYTES) {
      const gb = Math.max(0.1, Math.round((free / 1024 ** 3) * 10) / 10);
      lines.push({ id: 'disk', text: t('flow.startup.disk', { gb }), fix: null });
    }
  } catch {
    /* unreadable: nothing to say */
  }

  // 4. The update channel.
  try {
    if (!(await deps.updateReachable())) lines.push({ id: 'update', text: t('flow.startup.update'), fix: { kind: 'settings', label: t('flow.startup.checkSetup'), page: 'overview' } });
  } catch {
    /* unreadable: nothing to say */
  }

  // 5. "Show terminals" is off, but every agent the person has can only run in a terminal: nothing could be started.
  try {
    const [view, settings] = await Promise.all([deps.lanes(), deps.settings()]);
    const installed = health.filter((a) => a.installed).map((a) => a.id);
    if (view && settings && installed.length > 0 && !terminalsShown(settings)) {
      const chatIds = new Set([...chatCapable(view), ...terminalChatCapable(view)].map((a) => a.id));
      if (installed.every((id) => !chatIds.has(id))) lines.push({ id: 'terminals', text: t('flow.startup.terminals'), fix: { kind: 'terminals', label: t('flow.startup.showTerminals') } });
    }
  } catch {
    /* unreadable: nothing to say */
  }
  return lines;
}

const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** The real sources. `bridgeUp` is given by the cockpit (it knows the bridge state). */
export function tauriStartupDeps(bridgeUp: () => boolean): StartupDeps {
  return {
    agentHealth: () => agentHealthApi.check(),
    bridgeUp,
    diskFreeBytes: async () => (await invoke<{ freeBytes: number | null }>('disk_space')).freeBytes,
    updateReachable: async () => {
      try {
        await tauriUpdateTransport.check();
        return true;
      } catch {
        return false;
      }
    },
    lanes: async () => {
      const { tauriAcpChatApi } = await import('./acpChat');
      return tauriAcpChatApi.laneGet();
    },
    settings: async () => {
      const { loadSettings } = await import('./settings');
      return (await loadSettings()) as TerminalSwitchSettings;
    },
  };
}

/**
 * Outside the desktop app (a browser, a test) there is nothing to check. The dev harness (screenshots) switches it off unless
 * a scenario asks for it, so the line does not appear in every other screen.
 */
export const canStartupCheck = (): boolean => inTauri() && !(window as unknown as { __pmNoStartupCheck?: boolean }).__pmNoStartupCheck;
