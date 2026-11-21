// Everything this PC kept on its own about one other PC, forgotten when that PC is unlinked or removed (from here, from the other
// PC, or by the backend): its kept chat transcripts (old `pm.remoteChat.` copies), its message-box drafts and any other local state keyed by `device:<node>:` or
// `dev:<node>:` (view mode, plan progress, workflow cards, folded groups). One helper, so every unlink path does the same.

/** Only our own keys are looked at. */
const OURS = 'pm.';

export function clearDeviceLocalState(node: string): void {
  if (!node) return;
  const marks = [`device:${node}:`, `dev:${node}:`];
  const mine = (text: string) => marks.some((m) => text.startsWith(m));
  const mentions = (text: string) => marks.some((m) => text.includes(m)) || text === node || text.startsWith(`${node}:`) || text.includes(`:${node}:`);
  try {
    const store = window.localStorage;
    for (let i = store.length - 1; i >= 0; i -= 1) {
      const name = store.key(i);
      if (!name || !name.startsWith(OURS)) continue;
      if (marks.some((m) => name.includes(m))) {
        store.removeItem(name);
        continue;
      }
      const raw = store.getItem(name);
      if (!raw || !raw.includes(node)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (Array.isArray(parsed)) {
        const left = parsed.filter((v) => !(typeof v === 'string' && mentions(v)));
        if (left.length !== parsed.length) store.setItem(name, JSON.stringify(left));
      } else if (parsed && typeof parsed === 'object') {
        const entries = Object.entries(parsed);
        const left = entries.filter(([k]) => !mentions(k));
        if (left.length !== entries.length) store.setItem(name, JSON.stringify(Object.fromEntries(left)));
      }
    }
  } catch {
    /* closed storage: nothing was kept */
  }
}
