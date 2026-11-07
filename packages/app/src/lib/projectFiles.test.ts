import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { createProjectFileSearcher, PROJECT_FILE_LIMIT, searchProjectFiles, type ProjectFileHit } from './projectFiles';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const HIT: ProjectFileHit = { path: 'a/b.ts', absPath: 'C:/w/a/b.ts', name: 'b.ts', size: 3 };

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe('searchProjectFiles', () => {
  it('calls project_files_search with pane, query and limit', async () => {
    vi.mocked(invoke).mockResolvedValue([HIT]);
    await expect(searchProjectFiles('p1', 'b', 5)).resolves.toEqual([HIT]);
    expect(invoke).toHaveBeenCalledWith('project_files_search', { paneId: 'p1', query: 'b', limit: 5 });
  });

  it('defaults the limit to 8', async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await searchProjectFiles('p1', '');
    expect(invoke).toHaveBeenCalledWith('project_files_search', { paneId: 'p1', query: '', limit: PROJECT_FILE_LIMIT });
  });

  it('drops malformed entries and non-array replies', async () => {
    vi.mocked(invoke).mockResolvedValue([HIT, { path: 1 }, null]);
    await expect(searchProjectFiles('p1', 'b')).resolves.toEqual([HIT]);
    vi.mocked(invoke).mockResolvedValue({ nope: true });
    await expect(searchProjectFiles('p1', 'b')).resolves.toEqual([]);
  });
});

describe('createProjectFileSearcher', () => {
  it('returns null for a search superseded by a newer one', async () => {
    const pending: Array<(v: unknown) => void> = [];
    vi.mocked(invoke).mockImplementation(() => new Promise((r) => pending.push(r)));
    const s = createProjectFileSearcher();
    const first = s.search('p1', 'a');
    const second = s.search('p1', 'ab');
    pending[0]([HIT]);
    pending[1]([HIT]);
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toEqual([HIT]);
  });

  it('returns null for an in-flight search after cancel', async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(invoke).mockImplementation(() => new Promise((r) => (resolve = r)));
    const s = createProjectFileSearcher();
    const p = s.search('p1', 'a');
    s.cancel();
    resolve([HIT]);
    await expect(p).resolves.toBeNull();
  });
});
