// The cockpit's single "Needs you" list (see lib/attention.ts). CockpitApp derives it once, with
// the Ask-bar notices included, and shares it through context; a component rendered without that
// provider (a test, a storybook) derives the same list from the cockpit state alone.
import { createContext, useContext, useEffect, useMemo } from 'react';
import { attentionMismatch, deriveNeedsYou, isBlockingKind, type AttentionInput, type NeedsYouItem } from '../lib/attention';
import { useAttention } from './useAttention';
import { tauriAskbarApi, useAskNotices, type AskbarApi } from '../lib/askbar';
import { useLoopGuard } from '../lib/loop-guard';
import { useStalls } from '../lib/stalls';
import type { CockpitApi } from './useCockpit';
import type { FarQuestion } from '../lib/runtime/farQuestions';

export const NeedsYouContext = createContext<NeedsYouItem[] | null>(null);

/** What other PCs wait on (their questions and approvals), for the Inbox to draw and answer. The cockpit provides it from the device groups. */
export interface FarNeeds {
  questions: readonly FarQuestion[];
  /** Every question the far PCs wait on, the Inbox-dismissed ones too: the far chat they belong to keeps drawing its card. Absent: `questions`. */
  chatQuestions?: readonly FarQuestion[];
  /** Opens the far chat a card belongs to (its key is `dev:<node>:<pane id>`); false when this PC does not list that chat. */
  open?: (paneKey: string) => boolean;
  answer: (key: string, answer: { choice_id?: string; text?: string }) => Promise<void>;
  hide: (key: string) => void;
}
export const FarNeedsContext = createContext<FarNeeds | null>(null);

/** One far question as a needs-you item: it counts once, in every surface that counts (`question:dev:<node>:<id>`). */
const farItems = (far: ReadonlyArray<Pick<FarQuestion, 'key' | 'seenAt'>>): NeedsYouItem[] => far.map((q) => ({ id: `question:${q.key}`, kind: 'question', since: q.seenAt }));

type CockpitState = Pick<CockpitApi, 'registry' | 'prompts' | 'asked' | 'statusSince'>;

/** A pane the loop guard flagged and a helper with no progress are one problem: one id, so one card and one count. */
const stuckIds = (signals: Record<string, unknown>, stalls: ReadonlyMap<string, number>): string[] => [...new Set([...Object.keys(signals), ...stalls.keys()])];

type MissionFacts = AttentionInput['missions'];

function derive(c: CockpitState, stuckPaneIds: string[], notices: { id: string; at_ms?: number }[], missions?: MissionFacts, companions?: AttentionInput['companions'], teamRed?: AttentionInput['teamRed'], lendRequests?: AttentionInput['lendRequests']): NeedsYouItem[] {
  return deriveNeedsYou({
    panes: c.registry.paneList.map((p) => ({ id: p.info.id, status: p.status })),
    prompts: c.prompts,
    questions: c.asked.questions,
    stuckPaneIds,
    notices,
    statusSince: c.statusSince,
    missions,
    companions,
    teamRed,
    lendRequests,
  });
}

/** For CockpitApp: derive once and provide. Includes the Ask-bar answers nobody saw yet. */
export function useNeedsYouSource(
  c: CockpitState,
  signals: Record<string, unknown>,
  askbar: AskbarApi = tauriAskbarApi,
  /** The missions list (`useMissions`): a mission card counts once, like in the Rust snapshot. */
  missions?: MissionFacts,
  /** The companions list: one that stopped for good counts once, like its Rust card. */
  companions?: AttentionInput['companions'],
  /** War Room: unclaimed red default branches (`useTeam`), like the Rust `team_ci:` items. */
  teamRed?: AttentionInput['teamRed'],
  /** Share an agent: open requests to borrow from me (`useLend`). */
  lendRequests?: AttentionInput['lendRequests'],
  /** What other PCs wait on: each counts once, with this PC's own items, so the number, the sidebar and the Inbox agree. */
  farQuestions?: ReadonlyArray<Pick<FarQuestion, 'key' | 'seenAt'>>,
): NeedsYouItem[] {
  const { notices } = useAskNotices(askbar);
  const stalls = useStalls();
  const items = useMemo(() => [...derive(c, stuckIds(signals, stalls), notices, missions, companions, teamRed, lendRequests), ...farItems(farQuestions ?? [])], [c.registry.paneList, c.prompts, c.asked.questions, c.statusSince, signals, stalls, notices, missions, companions, teamRed, lendRequests, farQuestions]); // eslint-disable-line react-hooks/exhaustive-deps
  useShadowCheck(items);
  return items;
}

/**
 * Dev builds only: the Rust attention snapshot (src-tauri/src/attention) runs next to this
 * derivation, and a disagreement that lasts more than a second is a console warning. Nothing is
 * rendered from the snapshot here; this is how a drift between the two implementations is noticed.
 */
function useShadowCheck(items: NeedsYouItem[]): void {
  const snapshot = useAttention();
  useEffect(() => {
    if (!import.meta.env.DEV || !snapshot) return;
    // Another PC's cards are not in this PC's Rust snapshot: they are not compared.
    const mine = items.filter((i) => !i.id.startsWith('question:dev:'));
    if (attentionMismatch(mine, snapshot, isBlockingKind).length === 0) return;
    const timer = window.setTimeout(() => {
      const diff = attentionMismatch(mine, snapshot, isBlockingKind);
      if (diff.length > 0) console.warn('[attention] front-end and Rust lists disagree:', diff);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [items, snapshot]);
}

/** For any cockpit surface: the shared list, or the same derivation without Ask-bar notices. */
export function useNeedsYou(c: CockpitState): NeedsYouItem[] {
  const shared = useContext(NeedsYouContext);
  const { signals } = useLoopGuard();
  const stalls = useStalls();
  const local = useMemo(() => derive(c, stuckIds(signals, stalls), []), [c.registry.paneList, c.prompts, c.asked.questions, c.statusSince, signals, stalls]); // eslint-disable-line react-hooks/exhaustive-deps
  return shared ?? local;
}
