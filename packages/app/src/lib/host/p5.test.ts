// @vitest-environment jsdom
// P5: the files, artifact, review and usage apis of another PC are the same calls over `POST /pclink/call/<cmd>`; this PC keeps its own api;
// a call the far PC does not have never leaves this PC; a preview opens the far window through the app's protocol and never a port here.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a), convertFileSrc: (p: string, s: string) => `${s}://${p}` }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { DevicesFake, MAC_MINI, MAC_PANES, NODE_MAC } from '../../dev/devices-fixtures';
import { artifactsApi, artifactsApiFor } from '../artifacts';
import { filesApi, filesApiFor } from '../files-api';
import { previewAttachment } from '../attachFiles';
import { checkpointsApiFor, cockpitApi, worktreeApiFor } from '../cockpit-api';
import { paneUsageFor } from '../pane-usage';
import { searchProjectFilesOn } from '../projectFiles';
import { makePcLinkClient } from '../runtime/pclink';
import { turnReviewApi, turnReviewApiFor } from '../turn-review';
import { FAR_CALLS, farHost } from './far';
import { localHost } from './local';
import { openPreviewInBrowserOn, openPreviewOn } from './previews';
import { placeKey } from './placeKey';

function far() {
  const f = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } });
  f.farLevels[NODE_MAC] = 'full';
  const request = vi.spyOn(f, 'request').mockResolvedValue({ status: 200, body: { ok: true } } as never);
  const host = farHost(makePcLinkClient(NODE_MAC, f), f, { name: 'Mac mini', calls: new Set([...FAR_CALLS].filter((c) => c !== 'pane_open_bundle')) });
  return { host, request };
}

describe('P5 apis over a host', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });

  it('this PC keeps the api objects it always had', () => {
    expect(filesApiFor(localHost)).toBe(filesApi);
    expect(artifactsApiFor(localHost)).toBe(artifactsApi);
    expect(turnReviewApiFor(localHost)).toBe(turnReviewApi);
  });

  it('a far files api sends the same args to the far call table, with the chat key turned into the far id', async () => {
    const { host, request } = far();
    const key = placeKey(host.place, 'p1');
    const api = filesApiFor(host);
    await api.list(key, 'src', true);
    await api.read(key, 'src/a.ts');
    await api.diff(key, 'src/a.ts');
    await api.write(key, 'src/a.ts', 'x', 'v1', false);
    await api.marks(key);
    expect(request.mock.calls.map(([, method, path, body]) => [method, path, body])).toEqual([
      ['POST', '/pclink/call/files_list', { paneId: 'p1', path: 'src', showHeavy: true }],
      ['POST', '/pclink/call/files_read', { paneId: 'p1', path: 'src/a.ts' }],
      ['POST', '/pclink/call/files_diff', { paneId: 'p1', path: 'src/a.ts' }],
      ['POST', '/pclink/call/files_write', { paneId: 'p1', path: 'src/a.ts', text: 'x', baseVersion: 'v1', overwrite: false }],
      ['POST', '/pclink/call/files_marks', { paneId: 'p1' }],
    ]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('a far Word, Excel or PDF file opens from its bytes, and a too-large one says so', async () => {
    const { host, request } = far();
    request.mockResolvedValueOnce({ status: 200, body: { path: 'a.pdf', name: 'a.pdf', size: 2, kind: 'bytes', base64: 'AQI=' } } as never);
    const opened = await filesApiFor(host).openBytes(placeKey(host.place, 'p1'), 'a.pdf');
    expect(opened.kind).toBe('stream');
    expect(opened.source && 'bytes' in opened.source ? [...opened.source.bytes] : null).toEqual([1, 2]);
    request.mockResolvedValueOnce({ status: 200, body: { path: 'b.pdf', name: 'b.pdf', size: 99999999, kind: 'too_large' } } as never);
    expect((await filesApiFor(host).openBytes(placeKey(host.place, 'p1'), 'b.pdf')).kind).toBe('too_large');
  });

  it('what only this PC window can do (show in Explorer, open in a program) is never sent to the far PC', async () => {
    const { host, request } = far();
    await expect(filesApiFor(host).reveal(placeKey(host.place, 'p1'), 'a.ts')).rejects.toThrow(/Mac mini/);
    await expect(filesApiFor(host).openDefault(placeKey(host.place, 'p1'), 'a.docx')).rejects.toThrow(/Mac mini/);
    await expect(artifactsApiFor(host).popOut(placeKey(host.place, 'p1'), 'a', 'T')).rejects.toThrow(/Mac mini/);
    expect(request).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('the artifact page, the review, the put back and the usage are far calls too', async () => {
    const { host, request } = far();
    const key = placeKey(host.place, 'p1');
    await artifactsApiFor(host).read(key, 'a1', 2);
    await artifactsApiFor(host).sync(key);
    await turnReviewApiFor(host).review(key);
    await turnReviewApiFor(host).patch(key, 'c1', 'c2', 'a.ts');
    await turnReviewApiFor(host).putBack(key, 'c1', 'a.ts');
    await paneUsageFor(host, key);
    expect(request.mock.calls.map(([, , path, body]) => [path, body])).toEqual([
      ['/pclink/call/artifacts_read', { paneId: 'p1', id: 'a1', version: 2 }],
      ['/pclink/call/artifacts_sync', { paneId: 'p1' }],
      ['/pclink/call/checkpoint_turn_review', { paneId: 'p1' }],
      ['/pclink/call/checkpoint_file_patch', { paneId: 'p1', fromId: 'c1', toId: 'c2', path: 'a.ts' }],
      ['/pclink/call/checkpoint_put_back', { paneId: 'p1', beforeId: 'c1', path: 'a.ts' }],
      ['/pclink/call/pane_usage', { paneId: 'p1' }],
    ]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('the checkpoints and the @ file search are far calls too, and this PC keeps its own', async () => {
    const { host, request } = far();
    const key = placeKey(host.place, 'p1');
    expect(checkpointsApiFor(localHost)).toBe(cockpitApi);
    await checkpointsApiFor(host).checkpointsList(key);
    await checkpointsApiFor(host).checkpointRestore(key, 'c1');
    await checkpointsApiFor(host).checkpointUndoLast(key);
    request.mockResolvedValueOnce({ status: 200, body: [{ path: 'a.ts', absPath: '/w/a.ts', name: 'a.ts', size: 1 }, { nope: 1 }] } as never);
    const hits = await searchProjectFilesOn(host)(key, 'a', 8);
    expect(hits.map((h) => h.path)).toEqual(['a.ts']);
    expect(request.mock.calls.map(([, , path, body]) => [path, body])).toEqual([
      ['/pclink/call/checkpoints_list', { paneId: 'p1' }],
      ['/pclink/call/checkpoint_restore', { paneId: 'p1', id: 'c1' }],
      ['/pclink/call/checkpoint_undo_last', { paneId: 'p1' }],
      ['/pclink/call/project_files_search', { paneId: 'p1', query: 'a', limit: 8 }],
    ]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("a far chat's separate copy: the four calls name the chat and the copy's handle, never a project path; a chat with no copy reads as none", async () => {
    const { host, request } = far();
    const key = placeKey(host.place, 'p1');
    const api = worktreeApiFor(host, key);
    expect(worktreeApiFor(localHost, 'p1')).toBe(cockpitApi);
    request.mockResolvedValueOnce({ status: 200, body: {} } as never);
    expect(await api.paneWorktree(key)).toBeNull();
    request.mockResolvedValueOnce({ status: 200, body: { handle: 'h1', repo: '/far/proj', exists: true } } as never);
    expect((await api.paneWorktree(key))?.handle).toBe('h1');
    await api.worktreeDiff('/anything/the/screen/holds', 'h1', 'a.ts');
    await api.worktreeMerge('/anything', 'h1');
    await api.worktreeDiscard('/anything', 'h1');
    expect(request.mock.calls.map(([, , path, body]) => [path, body]).slice(2)).toEqual([
      ['/pclink/call/worktree_diff', { paneId: 'p1', handle: 'h1', path: 'a.ts' }],
      ['/pclink/call/worktree_merge', { paneId: 'p1', handle: 'h1' }],
      ['/pclink/call/worktree_discard', { paneId: 'p1', handle: 'h1' }],
    ]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("a far picture's thumbnail is asked of the far PC with its chat; this PC's own is asked by path alone", async () => {
    const { host, request } = far();
    request.mockResolvedValue({ status: 200, body: 'data:image/png;base64,AAAA' } as never);
    expect(await previewAttachment('/far/proj/a.png', host, placeKey(host.place, 'p1'))).toBe('data:image/png;base64,AAAA');
    expect(request).toHaveBeenCalledWith(NODE_MAC, 'POST', '/pclink/call/attachment_preview', { paneId: 'p1', path: '/far/proj/a.png' });
    invokeMock.mockResolvedValue('data:image/png;base64,BBBB');
    await previewAttachment('C:/mine/b.png', localHost, 'p1');
    expect(invokeMock).toHaveBeenCalledWith('attachment_preview', { path: 'C:/mine/b.png' });
  });

  it('this PC reads its own usage with its own command', async () => {
    await paneUsageFor(localHost, 'p1');
    expect(invokeMock).toHaveBeenCalledWith('pane_usage', { paneId: 'p1' });
  });

  it('a far preview opens the far window by the chat id and port, and never this PC loopback or browser', async () => {
    const { host, request } = far();
    const key = placeKey(host.place, 'p1');
    await openPreviewOn(host, key, 5173);
    await openPreviewInBrowserOn(host, key, { url: 'http://localhost:5173/', port: 5173 });
    expect(invokeMock.mock.calls).toEqual([
      ['far_preview_open', { node: NODE_MAC, pane_id: 'p1', port: 5173 }],
      ['far_preview_open', { node: NODE_MAC, pane_id: 'p1', port: 5173 }],
    ]);
    expect(request).not.toHaveBeenCalled();
    invokeMock.mockClear();
    await openPreviewOn(localHost, 'p1', 3000);
    expect(invokeMock).toHaveBeenCalledWith('point_open_preview', { paneId: 'p1', port: 3000 });
  });
});
