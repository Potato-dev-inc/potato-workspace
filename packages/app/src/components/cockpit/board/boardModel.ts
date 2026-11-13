// The agent board's data, as plain functions: which column each pane is in, what its tile shows, and which
// answers may be given on the tile. No React here, so the rules are tested on their own.
import type { PanePrompt, PromptChoice } from '../../../lib/cockpit-api';
import { activityText, type ActivityMap } from '../../../lib/pane-activity';
import { isBlockingKind, type NeedsYouItem } from '../../../lib/attention';
import { isCompanionPaneId } from '../companion/model';

export type BoardColumn = 'needs' | 'working' | 'done';

/** The order the columns show in. */
export const BOARD_COLUMNS: readonly BoardColumn[] = ['needs', 'working', 'done'];

export interface BoardTile {
  paneId: string;
  column: BoardColumn;
  agentType: string;
  name: string;
  project: string;
  /** The live last line of the pane, or null when it has none (or it belongs to another status). */
  activity: string | null;
  /** Epoch ms since the pane entered its current status, or null when unknown. */
  since: number | null;
  /** The prompt the quick answers belong to (null when there is no open prompt). */
  promptId: string | null;
  /** The answers the tile offers: only a low-risk yes/no approval (exactly two choices). Empty otherwise. */
  quickChoices: PromptChoice[];
}

export interface BoardPaneInput {
  info: { id: string; agent_type: string; cwd: string };
  status: string;
}

export interface BoardInput {
  panes: ReadonlyArray<BoardPaneInput>;
  names: ReadonlyMap<string, string>;
  prompts: Readonly<Record<string, PanePrompt | null | undefined>>;
  statusSince: ReadonlyMap<string, number>;
  needsYou: ReadonlyArray<NeedsYouItem>;
  activity: ActivityMap;
  projectOf: (cwd: string) => string;
}

export type BoardColumns = Record<BoardColumn, BoardTile[]>;

/**
 * The quick answers a tile may show: only while the pane waits, the prompt is rated low risk, and it has exactly
 * two choices (a yes and a no). Anything else opens the full card.
 */
export function quickChoicesFor(status: string, prompt: PanePrompt | null | undefined): PromptChoice[] {
  if (status !== 'waiting_input' || !prompt) return [];
  if (prompt.risk?.level !== 'low' || prompt.choices.length !== 2) return [];
  return prompt.choices;
}

/**
 * The column of a pane. "Needs you": it waits for an answer, it errored, or the attention list names it as blocked.
 * "Working": it runs. Everything else is "Done" (idle, finished).
 */
export function columnFor(status: string, blocked: boolean): BoardColumn {
  if (blocked || status === 'waiting_input' || status === 'error') return 'needs';
  if (status === 'running') return 'working';
  return 'done';
}

/** Every pane sorted into the three columns. Companion panes are not agents on the board, so they are left out. */
export function buildBoard(input: BoardInput): BoardColumns {
  const blocked = new Set<string>();
  for (const item of input.needsYou) {
    if (item.paneId && isBlockingKind(item.kind)) blocked.add(item.paneId);
  }
  const out: BoardColumns = { needs: [], working: [], done: [] };
  for (const pane of input.panes) {
    const id = pane.info.id;
    if (isCompanionPaneId(id)) continue;
    const prompt = input.prompts[id];
    const name = input.names.get(id) ?? pane.info.agent_type;
    const column = columnFor(pane.status, blocked.has(id));
    out[column].push({
      paneId: id,
      column,
      agentType: pane.info.agent_type,
      name,
      project: input.projectOf(pane.info.cwd),
      activity: activityText(pane.status, input.activity[id]),
      since: input.statusSince.get(id) ?? null,
      promptId: prompt?.promptId ?? null,
      quickChoices: quickChoicesFor(pane.status, prompt),
    });
  }
  return out;
}

export type ElapsedUnit = 'now' | 'minutes' | 'hours';

/** How long a pane has been in its state, in the coarsest unit that fits. Under a minute is "now". */
export function elapsedParts(ms: number): { unit: ElapsedUnit; count: number } {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (safe < 60_000) return { unit: 'now', count: 0 };
  if (safe < 3_600_000) return { unit: 'minutes', count: Math.floor(safe / 60_000) };
  return { unit: 'hours', count: Math.floor(safe / 3_600_000) };
}
