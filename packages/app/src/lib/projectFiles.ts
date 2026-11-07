import { invoke } from '@tauri-apps/api/core';

/** One file the `@` picker can offer. `path` is relative to the project, forward slashes. */
export interface ProjectFileHit {
  path: string;
  absPath: string;
  name: string;
  size: number;
}

export const PROJECT_FILE_LIMIT = 8;

function isHit(value: unknown): value is ProjectFileHit {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.path === 'string' && typeof v.absPath === 'string' && typeof v.name === 'string' && typeof v.size === 'number';
}

/** Calls the `project_files_search` backend command. Resolves to an empty list on a malformed reply. */
export function searchProjectFiles(paneId: string, query: string, limit: number = PROJECT_FILE_LIMIT): Promise<ProjectFileHit[]> {
  return invoke<unknown>('project_files_search', { paneId, query, limit }).then((reply) =>
    Array.isArray(reply) ? reply.filter(isHit) : [],
  );
}

export interface ProjectFileSearcher {
  /**
   * Starts a search. Resolves to the hits, or to `null` when a newer search (or `cancel`)
   * superseded this one, so the caller can ignore it.
   */
  search(paneId: string, query: string, limit?: number): Promise<ProjectFileHit[] | null>;
  /** Marks any in-flight search as stale. */
  cancel(): void;
}

/** Keeps a sequence number so only the newest search may apply its result. */
export function createProjectFileSearcher(): ProjectFileSearcher {
  let seq = 0;
  return {
    search(paneId, query, limit = PROJECT_FILE_LIMIT) {
      const mine = ++seq;
      return searchProjectFiles(paneId, query, limit).then(
        (hits) => (mine === seq ? hits : null),
        () => (mine === seq ? [] : null),
      );
    },
    cancel() {
      seq++;
    },
  };
}
