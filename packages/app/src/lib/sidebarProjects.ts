// The sidebar's Projects view: the folders the person added, which ones are folded, and how the list is grouped.
// Saved in browser storage (a per-viewer convenience). Pure helpers first, then small hooks. Never throws.
import { useCallback, useEffect, useState } from 'react';
import { projectOfCwd } from './ship-model';

export const LS_SIDEBAR_PROJECTS = 'pm.sidebar.projects';
export const LS_PROJECTS_FOLDED = 'pm.sidebar.projectsFolded';
export const LS_GROUP_BY = 'pm.sidebar.groupBy';
const MAX_PROJECTS = 60;

export interface SidebarProject {
  /** The folder. */
  path: string;
  /** A name the person gave it; absent means the folder's own name. */
  name?: string;
}

export type GroupBy = 'projects' | 'status';

/** The folder name at the end of a path. */
export const folderName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

/** The shown name of a project. */
export const projectLabel = (p: SidebarProject): string => p.name?.trim() || folderName(p.path);

/** A path as a comparison key: forward slashes, no trailing slash, lower case for Windows paths (they ignore case). */
export function pathKey(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(slashed) || path.includes('\\') ? slashed.toLowerCase() : slashed;
}

/** `cwd` is the folder itself or somewhere inside it. */
export function isInside(cwd: string, folder: string): boolean {
  const c = pathKey(cwd);
  const f = pathKey(folder);
  return f !== '' && (c === f || c.startsWith(`${f}/`));
}

/** The folders added so far. Broken storage reads as none. */
export function readProjects(): SidebarProject[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LS_SIDEBAR_PROJECTS) ?? 'null');
    if (!Array.isArray(parsed)) return [];
    const out: SidebarProject[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const { path, name } = item as { path?: unknown; name?: unknown };
      if (typeof path !== 'string' || path === '' || out.some((p) => pathKey(p.path) === pathKey(path))) continue;
      out.push(typeof name === 'string' && name.trim() ? { path, name } : { path });
    }
    return out.slice(0, MAX_PROJECTS);
  } catch {
    return [];
  }
}

export function writeProjects(list: readonly SidebarProject[]): void {
  try {
    localStorage.setItem(LS_SIDEBAR_PROJECTS, JSON.stringify(list.slice(0, MAX_PROJECTS)));
  } catch {
    /* storage is off: the list lasts until the window closes */
  }
}

/** `list` with `path` added at the end (nothing changes when it is there already). */
export const withProject = (list: readonly SidebarProject[], path: string): SidebarProject[] =>
  list.some((p) => pathKey(p.path) === pathKey(path)) ? [...list] : [...list, { path }];

export const withoutProject = (list: readonly SidebarProject[], path: string): SidebarProject[] =>
  list.filter((p) => pathKey(p.path) !== pathKey(path));

/** A new name; an empty name goes back to the folder's own name. */
export const renamedProject = (list: readonly SidebarProject[], path: string, name: string): SidebarProject[] =>
  list.map((p) => (pathKey(p.path) === pathKey(path) ? (name.trim() ? { path: p.path, name: name.trim() } : { path: p.path }) : p));

export interface ProjectGroup<T> {
  /** Stable key: the folder's path key, or `other`. */
  key: string;
  /** The folder; null for "Other" (agents with no folder). */
  path: string | null;
  name: string;
  /** The person added this folder (it shows even with no agents, and can be removed). */
  added: boolean;
  items: T[];
}

/**
 * Groups `items` by project. An item belongs to the added project whose folder holds its cwd (the longest folder
 * wins). A folder with agents that was not added still gets its own group. Items with no cwd go last, under "Other".
 * Order: added projects as stored, then the other folders by first appearance, then Other.
 */
export function groupByProject<T>(
  items: readonly T[],
  cwdOf: (item: T) => string | null | undefined,
  projects: readonly SidebarProject[],
): ProjectGroup<T>[] {
  const groups: ProjectGroup<T>[] = projects.map((p) => ({ key: pathKey(p.path), path: p.path, name: projectLabel(p), added: true, items: [] }));
  const extra: ProjectGroup<T>[] = [];
  const other: ProjectGroup<T> = { key: 'other', path: null, name: 'Other', added: false, items: [] };
  for (const item of items) {
    const cwd = cwdOf(item);
    if (!cwd) {
      other.items.push(item);
      continue;
    }
    let best: ProjectGroup<T> | null = null;
    for (const g of groups) {
      if (g.path && isInside(cwd, g.path) && (!best || pathKey(g.path).length > pathKey(best.path as string).length)) best = g;
    }
    if (best) {
      best.items.push(item);
      continue;
    }
    // Not inside an added folder: its own group, named by the folder (a separate copy counts as its origin project).
    const origin = projectOfCwd(cwd);
    const path = origin?.path ?? cwd;
    let g = extra.find((x) => x.key === pathKey(path));
    if (!g) {
      g = { key: pathKey(path), path, name: origin?.name ?? folderName(path), added: false, items: [] };
      extra.push(g);
    }
    g.items.push(item);
  }
  return [...groups, ...extra, ...(other.items.length ? [other] : [])];
}

function readStrings(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function readGroupBy(): GroupBy {
  try {
    return localStorage.getItem(LS_GROUP_BY) === 'status' ? 'status' : 'projects';
  } catch {
    return 'projects';
  }
}

/** The added projects and the ways to change them; saved on every change. */
export function useSidebarProjects(): {
  projects: SidebarProject[];
  add: (path: string) => void;
  remove: (path: string) => void;
  rename: (path: string, name: string) => void;
} {
  const [projects, setProjects] = useState<SidebarProject[]>(readProjects);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === LS_SIDEBAR_PROJECTS && setProjects(readProjects());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const change = useCallback((edit: (list: SidebarProject[]) => SidebarProject[]) => {
    const next = edit(readProjects());
    writeProjects(next);
    setProjects(next);
  }, []);
  return {
    projects,
    add: useCallback((path) => change((l) => withProject(l, path)), [change]),
    remove: useCallback((path) => change((l) => withoutProject(l, path)), [change]),
    rename: useCallback((path, name) => change((l) => renamedProject(l, path, name)), [change]),
  };
}

/** Which project groups are folded (by group key), remembered. */
export function useFoldedProjects(): { folded: ReadonlySet<string>; toggle: (key: string) => void } {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set(readStrings(LS_PROJECTS_FOLDED)));
  const toggle = useCallback((key: string) => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      try {
        localStorage.setItem(LS_PROJECTS_FOLDED, JSON.stringify([...next].slice(-200)));
      } catch {
        /* the fold is a convenience */
      }
      return next;
    });
  }, []);
  return { folded, toggle };
}

/** The way the list is grouped, remembered. */
export function useGroupBy(): [GroupBy, (next: GroupBy) => void] {
  const [by, setBy] = useState<GroupBy>(readGroupBy);
  const set = useCallback((next: GroupBy) => {
    setBy(next);
    try {
      localStorage.setItem(LS_GROUP_BY, next);
    } catch {
      /* the choice lasts until the window closes */
    }
  }, []);
  return [by, set];
}
