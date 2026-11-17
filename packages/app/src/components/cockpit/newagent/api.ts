// What the New agent page reads and writes, behind one small interface so a test can hand it fakes. The real one
// calls the same commands the "+" menu, Settings and the chat tab already use; it adds no command of its own.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { pickFiles } from '../../../lib/attachFiles';
import { sendPaneMessage } from '../../../lib/paneOutbox';
import { pickableAccounts, tauriAccountsApi, type Account } from '../../../lib/accounts';
import { loadSettings, patchSettings } from '../../../lib/settings';
import { shipApi, type RecentProject } from '../../../lib/ship-api';
import { realRecents } from '../../../lib/ship-model';
import { isValidProjectPath } from '../../../lib/project-path';
import { tauri } from '../../../lib/tauri';
import { fillDiscordNameOnce } from '../../../lib/discordName';
import { cleanName, parseCards, type HomeCard, type LaneView } from './model';

const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** The settings the page shows: the name for the greeting and the pinned cards. */
export interface HomeSettings {
  name: string;
  cards: HomeCard[];
}

/** A workflow as the page shows it (Rust `crews::workflow::Plan`; the brief is filled only by `workflowPlan`). */
export interface WorkflowPlanView {
  name: string;
  front_name: string;
  front_agent: string;
  front_model: string | null;
  helpers: { name: string; agent_type: string; model: string | null; when_to_use: string; kind: 'minion' | 'spin_off' | string }[];
  start_mode: 'front' | 'horde' | string;
  helper_cap: number;
  reply_style: 'translator' | 'router' | string;
  brief: string;
  /** The brief, then the person's request: the front's first message. */
  first_message: string;
}

export interface WorkflowChoice {
  slug: string;
  plan: WorkflowPlanView;
}

export interface NewAgentApi {
  /** Labs "Workflows": the saved workflows; null while the switch is off. Absent on an older build. */
  workflows?: () => Promise<WorkflowChoice[] | null>;
  /** The plan of one workflow in a folder: who the front is and the brief it gets first. */
  workflowPlan?: (slug: string, folder: string, request: string) => Promise<WorkflowPlanView>;
  /** Whole-horde mode: start the helpers under the front's pane. Resolves to a plain sentence when some did not start. */
  workflowHelpers?: (slug: string, folder: string, frontPane: string) => Promise<string | null>;
  /** Recent project folders, newest first (copies mapped back to their project). */
  recent: () => Promise<RecentProject[]>;
  /** The system folder dialog; null when cancelled. */
  pickFolder: () => Promise<RecentProject | null>;
  /** The system file dialog (several files or folders); empty when cancelled. */
  pickPaths: () => Promise<string[]>;
  /** The app's default project folder, or null. */
  defaultFolder: () => Promise<string | null>;
  /** Git state of a folder the page only knows by path. */
  gitState: (path: string) => Promise<RecentProject['state']>;
  /** "How to run" per agent; null outside the desktop app or on an older build. */
  lanes: () => Promise<LaneView | null>;
  /** Saved logins per agent. */
  accounts: () => Promise<Account[]>;
  loadHome: () => Promise<HomeSettings>;
  saveCards: (cards: HomeCard[]) => Promise<void>;
  /** Called when Settings (any window) changes the name or the cards. Returns the stop function. */
  onHomeChanged: (cb: (next: Partial<HomeSettings>) => void) => Promise<() => void>;
}

interface LaneWire {
  labs_enabled?: boolean;
  agents?: { id: string; lane?: string; disabled?: boolean }[];
}

/** `agent_lane_get`'s answer as the page's LaneView. Anything odd is "no chat". */
export function laneViewFromWire(wire: LaneWire | null | undefined): LaneView | null {
  if (!wire || !Array.isArray(wire.agents)) return null;
  return {
    labsEnabled: wire.labs_enabled === true,
    agents: wire.agents
      .filter((a) => a && typeof a.id === 'string')
      .map((a) => ({ id: a.id, lane: a.lane === 'acp' ? ('acp' as const) : ('terminal' as const), disabled: a.disabled === true })),
  };
}

export const tauriNewAgentApi: NewAgentApi = {
  workflows: async () => {
    if (!inTauri()) return null;
    try {
      return await invoke<WorkflowChoice[] | null>('workflows_list');
    } catch {
      return null; // an older build without the command
    }
  },
  workflowPlan: (slug, folder, request) => invoke<WorkflowPlanView>('workflows_plan', { slug, folder, request }),
  workflowHelpers: async (slug, folder, frontPane) => {
    const out = await invoke<{ failed: { role: string; message: string } | null; started: unknown[]; note: string }>('workflows_start_helpers', { slug, folder, frontPane });
    // The front is told which pane is which helper, so it uses them and does not start duplicates.
    if (out.started.length > 0 && out.note) await sendPaneMessage(frontPane, out.note).catch(() => undefined);
    return out.failed ? `${out.failed.role}: ${out.failed.message}` : null;
  },
  recent: async () => realRecents(await shipApi.recent()),
  pickFolder: () => shipApi.pickFolder(),
  pickPaths: async () => pickFiles(),
  defaultFolder: async () => {
    const path = await tauri.getProjectPath();
    return isValidProjectPath(path) ? path : null;
  },
  gitState: (path) => shipApi.gitState(path),
  lanes: async () => {
    if (!inTauri()) return null;
    try {
      return laneViewFromWire(await invoke<LaneWire>('agent_lane_get'));
    } catch {
      return null; // an older build without the command: terminal only
    }
  },
  accounts: async () => {
    try {
      return pickableAccounts(await tauriAccountsApi.list());
    } catch {
      return [];
    }
  },
  loadHome: async () => {
    const s = await loadSettings();
    // Signed in with Discord and no name yet: start from the Discord name (once per account), at app start, not only in Settings.
    const filled = cleanName(s.display_name) ? null : await fillDiscordNameOnce((name) => patchSettings({ display_name: name }));
    return { name: filled ? cleanName(filled) : cleanName(s.display_name), cards: parseCards(s.home_cards) };
  },
  saveCards: async (cards) => {
    await patchSettings({ home_cards: cards.length > 0 ? cards : null });
  },
  onHomeChanged: async (cb) => {
    if (!inTauri()) return () => undefined;
    return listen<Record<string, unknown> | null>('settings://changed', (event) => {
      const p = event.payload;
      if (!p) return;
      const next: Partial<HomeSettings> = {};
      if ('display_name' in p) next.name = cleanName(typeof p.display_name === 'string' ? p.display_name : '');
      if ('home_cards' in p) next.cards = parseCards(p.home_cards);
      if (Object.keys(next).length > 0) cb(next);
    });
  },
};
