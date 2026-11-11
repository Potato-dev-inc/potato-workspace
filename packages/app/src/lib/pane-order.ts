// Moving between agents from the keyboard, and the order the palette lists them in. Pure functions plus a small
// memory of which pane was used when (in this window only; it starts empty on every launch).

const lastUsed = new Map<string, number>();
let tick = 0;

/** Remember that the person has just looked at this pane. */
export function recordPaneUse(id: string): void {
  tick += 1;
  lastUsed.set(id, tick);
}

export function paneLastUsed(): ReadonlyMap<string, number> {
  return lastUsed;
}

/** Tests only. */
export function clearPaneUse(): void {
  lastUsed.clear();
  tick = 0;
}

/**
 * The palette's order for panes: the ones that need you first, then the most recently used, then the rest in their
 * own order. Stable: two panes that tie keep the order they came in.
 */
export function rankPanes<T extends { id: string }>(panes: readonly T[], needsYou: ReadonlySet<string>, used: ReadonlyMap<string, number> = lastUsed): T[] {
  return panes
    .map((pane, index) => ({ pane, index }))
    .sort((a, b) => {
      const need = Number(needsYou.has(b.pane.id)) - Number(needsYou.has(a.pane.id));
      if (need !== 0) return need;
      const recent = (used.get(b.pane.id) ?? 0) - (used.get(a.pane.id) ?? 0);
      return recent !== 0 ? recent : a.index - b.index;
    })
    .map((x) => x.pane);
}

/** The pane after (`step` 1) or before (`step` -1) `selected` in the list, wrapping round. With none selected: the first or last. */
export function stepPane(ids: readonly string[], selected: string | null, step: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const at = selected === null ? -1 : ids.indexOf(selected);
  if (at < 0) return step === 1 ? ids[0] : ids[ids.length - 1];
  return ids[(at + step + ids.length) % ids.length];
}

/** The pane for the number 1 to 9, or null when there are not that many. */
export function paneAtNumber(ids: readonly string[], n: number): string | null {
  return n >= 1 && n <= 9 ? (ids[n - 1] ?? null) : null;
}

/**
 * The next pane that needs you, going down the list from `selected` and wrapping. The selected pane itself counts
 * only when it is the only one. Null when nothing needs you.
 */
export function nextNeedingPane(ids: readonly string[], needsYou: ReadonlySet<string>, selected: string | null): string | null {
  const waiting = ids.filter((id) => needsYou.has(id));
  if (waiting.length === 0) return null;
  const at = selected === null ? -1 : ids.indexOf(selected);
  for (let i = 1; i <= ids.length; i++) {
    const id = ids[(at + i + ids.length) % ids.length];
    if (needsYou.has(id) && id !== selected) return id;
  }
  return waiting[0];
}
