// Which chat is which box of a crew. "Start crew" says it (role + pane id); this remembers it on this computer so the
// Inbox can offer "Show in crew". A chat that was not started from a crew is simply not here, and gets no button.
const KEY = 'pm.crew.members';
const MAX = 200;

export interface CrewMember {
  slug: string;
  role: string;
}

function read(): Record<string, CrewMember> {
  try {
    const raw = window.localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' ? (v as Record<string, CrewMember>) : {};
  } catch {
    return {};
  }
}

/** A crew just started: remember each role's chat. The newest MAX are kept. */
export function rememberCrewStart(slug: string, started: ReadonlyArray<{ role: string; pane_id: string }>): void {
  if (started.length === 0) return;
  const all = read();
  for (const s of started) all[s.pane_id] = { slug, role: s.role };
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete all[k];
  try {
    window.localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage can be blocked: the button just does not show */
  }
}

/** The crew box this chat was started as, or null. */
export function crewOf(paneId: string | null | undefined): CrewMember | null {
  if (!paneId) return null;
  const m = read()[paneId];
  return m && typeof m.slug === 'string' && typeof m.role === 'string' ? m : null;
}
