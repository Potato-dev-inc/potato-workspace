// Timing marks for opening a chat, read with `performance.getEntriesByType('mark')` in a debug session. A mark only
// records a name and the time: no text, no paths. Nothing here changes what the person sees.

/** Records `chat:<name>` now. Never throws (an old webview without `performance.mark` is fine). */
export function markChat(name: string): void {
  try {
    performance.mark(`chat:${name}`);
  } catch {
    // no performance API: nothing to record
  }
}
