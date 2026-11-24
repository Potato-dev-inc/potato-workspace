// The agent reports the size of the context window twice: a default while it works (200k) and the model's real one in
// its end-of-turn report (1M for a long-context model). The meter would flip between "18% of 200k" and "4% of 1M". A chat's
// window for one model only grows: once a bigger one was reported it stays, so the denominator does not change back.
import type { UsageItem } from './sessionChatModel';

const seen = new Map<string, { model: string | null; window: number }>();

export function steadyUsage(paneId: string, model: string | null | undefined, usage: UsageItem | null): UsageItem | null {
  if (!usage?.contextWindow || usage.contextWindow <= 0) return usage;
  const kept = seen.get(paneId);
  const window = kept && kept.model === (model ?? null) ? Math.max(kept.window, usage.contextWindow) : usage.contextWindow;
  seen.set(paneId, { model: model ?? null, window });
  return window === usage.contextWindow ? usage : { ...usage, contextWindow: window };
}
