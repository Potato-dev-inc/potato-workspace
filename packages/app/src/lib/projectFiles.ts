import { invoke } from '@tauri-apps/api/core';
import { t } from '../i18n';
import { rawText } from './sayError';
import type { Host } from './host/host';

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

/** The same search on a place: this PC's own, or another PC's folder for that chat (`project_files_search` there). */
export function searchProjectFilesOn(host: Host): typeof searchProjectFiles {
  if (host.place.kind === 'local') return searchProjectFiles;
  const { name } = host.place;
  return (paneId, query, limit = PROJECT_FILE_LIMIT) =>
    host.invoke<unknown>('project_files_search', { paneId, query, limit }).then(
      (reply) => (Array.isArray(reply) ? reply.filter(isHit) : []),
      // A refusal is the far PC's "Browse and copy files" switch: say that, not a bare "no".
      (error: unknown) => Promise.reject(error instanceof Error && rawText(error) === t('pclink.notAllowed') ? new Error(t('files.mention.farOff', { name })) : error),
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
export function createProjectFileSearcher(find: typeof searchProjectFiles = searchProjectFiles, onError?: (error: unknown) => void): ProjectFileSearcher {
  let seq = 0;
  return {
    search(paneId, query, limit = PROJECT_FILE_LIMIT) {
      const mine = ++seq;
      return find(paneId, query, limit).then(
        (hits) => (mine === seq ? hits : null),
        (error: unknown) => {
          if (mine !== seq) return null;
          if (!onError) return [];
          onError(error);
          return null;
        },
      );
    },
    cancel() {
      seq++;
    },
  };
}
