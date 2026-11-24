// "Is that PC still answering?" The link state says `online` for as long as the relay path is up, even when the app on the far PC is dead,
// so a far chat that was Working kept saying Working. Every successful reply from a PC (a list, a card, an event, the small `me` check)
// is a beat; a PC with a Working or waiting chat that has not beaten for FAR_QUIET_MS is not answering. The next reply clears it.

export const FAR_QUIET_MS = 12_000;
/** How often a PC with a working chat is asked a small question, so quiet means something (the lists are read every 15 s). */
export const FAR_BEAT_MS = 5_000;

/** The PCs that have a chat the person believes is busy but have not answered for more than `quietMs`. Pure. */
export function quietNodes(busy: ReadonlySet<string>, lastReply: ReadonlyMap<string, number>, now: number, quietMs = FAR_QUIET_MS): Set<string> {
  const out = new Set<string>();
  for (const node of busy) {
    const last = lastReply.get(node);
    if (last !== undefined && now - last > quietMs) out.add(node);
  }
  return out;
}

/** What a row shows while its PC is not answering: a busy chat is Away, not Working. Anything else is left as it is. */
export const awayStatus = <S extends string>(status: S, quiet: boolean): S | 'away' => (quiet && (status === 'running' || status === 'waiting_input') ? 'away' : status);

/** The PCs asked the small question every FAR_BEAT_MS: only those with a chat that looks busy. A PC that is merely open on screen is not (its level is read every 15 s anyway, and the next list says when it got busy). */
export const beatTargets = (online: readonly string[], rows: Readonly<Record<string, readonly { ended?: boolean; status: string }[] | undefined>>): string[] =>
  online.filter((node) => (rows[node] ?? []).some((r) => !r.ended && (r.status === 'running' || r.status === 'waiting_input')));
