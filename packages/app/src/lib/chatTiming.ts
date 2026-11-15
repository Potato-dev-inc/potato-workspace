// Timing marks for opening a chat, read with `performance.getEntriesByType('mark')` in a debug session. A mark only
// records a name and the time: no text, no paths. Nothing here changes what the person sees.
//
// The buffer must not grow with a chat's life: each chat open records a fixed few marks (CHAT_OPEN_STAGES), and the
// open is measured and cleared as soon as it finishes (`finishChatOpen`), or when the view closes (`clearChatTiming`).

const PREFIX = 'chat:';

/** The marks one chat open records, in order. Anything else under `chat:` is cleared with the rest. */
export const CHAT_OPEN_STAGES = ['view:open', 'view:items', 'view:snapshot'] as const;

/** Records `chat:<name>` now. Never throws (an old webview without `performance.mark` is fine). */
export function markChat(name: string): void {
  try {
    performance.mark(`${PREFIX}${name}`);
  } catch {
    // no performance API: nothing to record
  }
}

/** Removes every `chat:` mark and measure, so nothing from an earlier open is left in the buffer. Never throws. */
export function clearChatTiming(): void {
  try {
    for (const entry of performance.getEntriesByType('mark')) {
      if (entry.name.startsWith(PREFIX)) performance.clearMarks(entry.name);
    }
    for (const entry of performance.getEntriesByType('measure')) {
      if (entry.name.startsWith(PREFIX)) performance.clearMeasures(entry.name);
    }
  } catch {
    // no performance API: nothing to clear
  }
}

/**
 * Measures the open (from `view:open` to `view:snapshot`), returns its length in ms, then clears the chat's marks and
 * measure. Returns null when either mark is missing (the open did not finish). Never throws.
 */
export function finishChatOpen(): number | null {
  try {
    const hasBoth =
      performance.getEntriesByName(`${PREFIX}view:open`, 'mark').length > 0 &&
      performance.getEntriesByName(`${PREFIX}view:snapshot`, 'mark').length > 0;
    const ms = hasBoth ? performance.measure(`${PREFIX}open`, `${PREFIX}view:open`, `${PREFIX}view:snapshot`).duration : null;
    clearChatTiming();
    return ms;
  } catch {
    clearChatTiming();
    return null;
  }
}
