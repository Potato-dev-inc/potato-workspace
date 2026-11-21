// The place (a Linux distro or an SSH machine of this PC) last used to start an agent for a project, remembered per project in
// browser storage (a per-viewer convenience). A paired device is never remembered across launches (see NewAgentWhere).

export const STORE_KEY = 'pm.newAgent.where';

export const isLocalPlace = (id: string | null): id is string => !!id && (id.startsWith('wsl:') || id.startsWith('ssh:'));

/** The place saved for `key` (a project path, or '' for none), or null. */
export function savedPlace(key: string): string | null {
  try {
    const all = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, unknown>;
    const v = all[key];
    return typeof v === 'string' && isLocalPlace(v) ? v : null;
  } catch {
    return null;
  }
}

export function savePlace(key: string, id: string | null): void {
  if (id && !isLocalPlace(id)) return;
  try {
    const all = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, unknown>;
    if (id) all[key] = id;
    else delete all[key];
    window.localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    /* the place is simply not remembered */
  }
}
