// "My messages": what the person sent. The chat's own messages come first (newest first), then older ones from any
// chat that the search index holds (Who = You). Used by the Up arrow in the message box and by Ctrl+R. Pure code.

export const MY_MESSAGES_LIMIT = 30;

/** The chat's own messages that hold `query` (case does not matter; empty holds all), newest first, each once. */
export function ownMatches(history: readonly string[], query: string, limit = MY_MESSAGES_LIMIT): string[] {
  const needle = query.trim().toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = history.length - 1; i >= 0 && out.length < limit; i--) {
    const text = history[i].trim();
    if (text === '' || seen.has(text)) continue;
    if (needle !== '' && !text.toLowerCase().includes(needle)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/** The own matches, then the other chats' texts (each once), cut to `limit`. */
export function mergeMine(own: readonly string[], others: readonly string[], limit = MY_MESSAGES_LIMIT): string[] {
  const seen = new Set(own);
  const out = [...own];
  for (const text of others) {
    const clean = text.trim();
    if (clean === '' || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out.slice(0, limit);
}

/** What the box holds after a message is picked: an empty box gets it; typed text keeps its place and gets it after a blank line. */
export function withPicked(current: string, picked: string): string {
  return current.trim() === '' ? picked : `${current}\n\n${picked}`;
}
