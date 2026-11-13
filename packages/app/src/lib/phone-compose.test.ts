// @vitest-environment jsdom
// The pure helpers behind phone compose: upload checks, quick replies, saved prompts, the progress note and the result card.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeClient } from './bridge-types';
import { diffLineKind, keepTurn, keptTurn, parsePatch, plainText, resultFiles, shareText, totals } from './phone-result';
import { minutesBetween, progressOf, publishProgress, progressNoteOf, resetProgressForTests } from './phone-progress';
import { asksSomething, quickRepliesFor, readSavedPrompts, slashFilter, withPrompt, writeSavedPrompts, MAX_SAVED_PROMPTS } from './phone-quick';
import { allowedType, checkUpload, UPLOAD_MAX_BYTES, uploadFile, uploadName } from './phone-upload';
import { groupTurns, type ChatItem } from './sessionChatModel';

beforeEach(() => {
  localStorage.clear();
  resetProgressForTests();
});

describe('upload checks', () => {
  it('takes pictures, PDF and common text files, and nothing else', () => {
    expect(allowedType('a.PNG', '')).toBe(true);
    expect(allowedType('paper.pdf', '')).toBe(true);
    expect(allowedType('notes.md', 'text/markdown')).toBe(true);
    expect(allowedType('run.exe', 'application/octet-stream')).toBe(false);
    expect(allowedType('archive.zip', 'application/zip')).toBe(false);
    expect(allowedType('', 'image/jpeg')).toBe(true);
    expect(allowedType('', 'video/mp4')).toBe(false);
  });

  it('refuses an empty file and a file over 10 MB, and takes exactly 10 MB', () => {
    expect(checkUpload({ name: 'a.png', size: 0, type: 'image/png' })).toEqual({ ok: false, reason: 'empty' });
    expect(checkUpload({ name: 'a.png', size: UPLOAD_MAX_BYTES + 1, type: 'image/png' })).toEqual({ ok: false, reason: 'big' });
    expect(checkUpload({ name: 'a.png', size: UPLOAD_MAX_BYTES, type: 'image/png' })).toEqual({ ok: true });
    expect(checkUpload({ name: 'a.exe', size: 10, type: '' })).toEqual({ ok: false, reason: 'type' });
  });

  it('gives a photo with no extension one from its type', () => {
    expect(uploadName({ name: '', type: 'image/jpeg' })).toBe('photo.jpg');
    expect(uploadName({ name: 'IMG_1', type: 'image/png' })).toBe('IMG_1.png');
    expect(uploadName({ name: 'a.webp', type: 'image/webp' })).toBe('a.webp');
  });

  it('sends the file as base64 to the upload route and turns a refusal into the PC sentence', async () => {
    const uploadPaneFile = vi.fn(async () => ({ name: 'a.png', path: '/x/a.png', kind: 'image' as const, size: 1 }));
    const bridge = { uploadPaneFile } as unknown as BridgeClient;
    const attachment = await uploadFile(bridge, 'p1', new File(['hi'], 'a.png', { type: 'image/png' }), 'failed');
    expect(attachment.path).toBe('/x/a.png');
    expect(uploadPaneFile).toHaveBeenCalledWith('p1', { name: 'a.png', mime: 'image/png', data_base64: 'aGk=' });
    const refused = { uploadPaneFile: vi.fn(async () => Promise.reject(new Error('bridge POST /panes/p1/uploads -> 403: {"error":"This agent is not open to your phone."}'))) } as unknown as BridgeClient;
    await expect(uploadFile(refused, 'p1', new File(['hi'], 'a.png', { type: 'image/png' }), 'failed')).rejects.toThrow('This agent is not open to your phone.');
    await expect(uploadFile({} as BridgeClient, 'p1', new File(['hi'], 'a.png'), 'failed')).rejects.toThrow('failed');
  });
});

describe('quick replies', () => {
  it('makes chips from a question, and none from a statement', () => {
    expect(quickRepliesFor('I changed the redirect. Want me to open a pull request?')).toEqual(['yes', 'no']);
    expect(quickRepliesFor('I finished step 2 of 5. Continue?')).toEqual(['continue', 'yes', 'no']);
    expect(quickRepliesFor('Should I run the tests now?')).toEqual(['yes', 'no', 'runTests']);
    expect(quickRepliesFor('All done. The file is saved.')).toEqual([]);
    expect(quickRepliesFor(null)).toEqual([]);
    expect(quickRepliesFor('要不要我繼續？')).toEqual(['continue', 'yes', 'no']);
  });

  it('never gives more than three chips and looks only at the end of a long answer', () => {
    expect(quickRepliesFor('Continue? Should I run the tests, the lint and the build?').length).toBeLessThanOrEqual(3);
    expect(asksSomething(`${'Is this long? '.repeat(100)}It is finished.`)).toBe(false);
  });
});

describe('saved prompts', () => {
  it('start unset, keep what was written, and never hold more than the limit', () => {
    expect(readSavedPrompts()).toBeNull();
    writeSavedPrompts(['a', 'b']);
    expect(readSavedPrompts()).toEqual(['a', 'b']);
    expect(withPrompt(['a', 'b'], ' b ')).toEqual(['b', 'a']);
    expect(withPrompt(['a'], '   ')).toEqual(['a']);
    expect(withPrompt(Array.from({ length: MAX_SAVED_PROMPTS }, (_, i) => `p${i}`), 'new')).toHaveLength(MAX_SAVED_PROMPTS);
  });

  it('opens on a slash with no space', () => {
    expect(slashFilter('/')).toBe('');
    expect(slashFilter('/Run')).toBe('run');
    expect(slashFilter('/run tests')).toBeNull();
    expect(slashFilter('hello /')).toBeNull();
  });
});

const live: ChatItem[] = [
  { kind: 'user', id: '1:0', at: '2026-11-13T12:00:00.000Z', text: 'go' },
  { kind: 'toolCall', id: '2:0', at: null, callId: 'c1', name: 'Bash', summary: 'cargo   test\n--lib', paths: [] },
];

describe('progress note', () => {
  it('names the action, counts the steps and starts from the first message', () => {
    const note = progressOf(groupTurns(live).turns, 'file', 0)!;
    expect(note.action).toBe('Bash cargo test --lib');
    expect(note.step).toBe(1);
    expect(note.startedAt).toBe(Date.parse('2026-11-13T12:00:00.000Z'));
    expect(minutesBetween(note.startedAt, note.startedAt + 6 * 60_000 + 5)).toBe(6);
  });

  it('has no step for a chat read off the screen, and no note once the turn ended', () => {
    expect(progressOf(groupTurns(live).turns, 'screen', 0)!.step).toBeNull();
    const ended: ChatItem[] = [...live, { kind: 'turnEnd', id: '3:0', at: null, outcome: 'completed', durationMs: 5 }];
    expect(progressOf(groupTurns(ended).turns, 'file', 0)).toBeNull();
  });

  it('cuts a very long action to one short line', () => {
    const long: ChatItem[] = [live[0]!, { ...(live[1] as Extract<ChatItem, { kind: 'toolCall' }>), summary: 'x'.repeat(400) }];
    expect(progressOf(groupTurns(long).turns, 'file', 0)!.action!.length).toBeLessThanOrEqual(80);
  });

  it('keeps the note of a chat for the drawer and clears it', () => {
    const note = progressOf(groupTurns(live).turns, 'file', 0)!;
    publishProgress('p1', note);
    expect(progressNoteOf('p1')).toEqual(note);
    publishProgress('p1', null);
    expect(progressNoteOf('p1')).toBeNull();
  });
});

describe('result card helpers', () => {
  const ended: ChatItem[] = [
    { kind: 'user', id: '1:0', at: null, text: 'go' },
    { kind: 'toolCall', id: '2:0', at: null, callId: 'c1', name: 'Edit', summary: 'a.ts', paths: ['a.ts'], writes: true },
    { kind: 'toolCall', id: '3:0', at: null, callId: 'c2', name: 'Read', summary: 'b.ts', paths: ['b.ts'] },
    { kind: 'toolCall', id: '4:0', at: null, callId: 'c3', name: 'Edit', summary: 'a.ts again', paths: ['a.ts'], writes: true },
  ];

  it('falls back to the files the chat changed, once each, without counts', () => {
    const turn = groupTurns(ended).turns[0]!;
    const files = resultFiles(turn, null);
    expect(files.map((f) => f.path)).toEqual(['a.ts']);
    expect(totals(files, null)).toEqual({ count: 1, added: null, deleted: null });
  });

  it('uses the PC list and totals when it has them', () => {
    const turn = groupTurns(ended).turns[0]!;
    const result = { available: true, files: { count: 2, added: 5, deleted: 1, paths: [] }, changes: [{ path: 'x', status: 'M', added: 3, deleted: 1, binary: false }, { path: 'y', status: 'A', added: 2, deleted: 0, binary: true }] };
    const files = resultFiles(turn, result);
    expect(files).toEqual([
      { path: 'x', added: 3, deleted: 1, status: 'M' },
      { path: 'y', added: null, deleted: null, status: 'A' },
    ]);
    expect(totals(files, result)).toEqual({ count: 2, added: 5, deleted: 1 });
  });

  it('splits a diff per file and tells the line kinds apart', () => {
    const blocks = parsePatch('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/b.ts b/b.ts\n+z\n');
    expect(blocks.map((b) => b.path)).toEqual(['a.ts', 'b.ts']);
    expect(diffLineKind('+y')).toBe('add');
    expect(diffLineKind('-x')).toBe('del');
    expect(diffLineKind('+++ b/a.ts')).toBe('plain');
    expect(diffLineKind('@@ -1 +1 @@')).toBe('hunk');
  });

  it('makes markdown plain for the short summary', () => {
    expect(plainText('Found it. The `/login` page was **wrong**.\n\n- one\n- two\n```\ncode\n```')).toBe('Found it. The /login page was wrong.\none\ntwo');
  });

  it('remembers Keep per chat and writes a share text', () => {
    expect(keptTurn('p1')).toBeNull();
    keepTurn('p1', '7:0');
    expect(keptTurn('p1')).toBe('7:0');
    expect(keptTurn('p2')).toBeNull();
    expect(shareText('Done', [{ path: 'a.ts', added: 2, deleted: 1, status: 'M' }, { path: 'b.ts', added: null, deleted: null, status: null }])).toBe('Done\na.ts (+2 −1)\nb.ts');
  });
});
