import { describe, expect, it } from 'vitest';
import type { LendProfile, LendState } from '../../lib/lend';
import type { RecvTask, SentTask } from '../../lib/team-tasks';
import {
  byteLength,
  canTakeBack,
  comesWith,
  lendChoices,
  lendableProfiles,
  lendOffered,
  passProblem,
  recvActions,
  repoDisabledReason,
  sentChip,
  sentRepoLine,
  SUMMARY_MAX_BYTES,
  TEXT_MAX_BYTES,
  waitingCount,
  type PassDraft,
} from './tasks-model';
import { tabCounts } from './team-page-model';

const draft = (over: Partial<PassDraft> = {}): PassDraft => ({ toMember: 'm-maya', title: 'Fix it', text: 'Please fix the sheet.', summaryOn: false, summary: '', choice: 'words', history: 'latest', understood: false, ...over });

const recv = (over: Partial<RecvTask> = {}): RecvTask => ({
  id: 't1', fromMember: 'm-maya', fromName: 'Maya', fromDevice: 'd1', title: 'Fix', text: 'Do it', summary: '', repo: null, lend: null, state: 'new', atMs: 1, updatedMs: 1,
  risk: null, usage: 'theirs', lendError: null, repoState: 'none', repoGot: 0, repoError: null, unpacked: null, ...over,
});
const sent = (over: Partial<SentTask> = {}): SentTask => ({
  id: 's1', toMember: 'm-maya', toName: 'Maya', toDevices: [], answeredDevice: null, title: 'Fix', text: 'Do it', summary: '', repo: null, lend: null, lendUsed: false, state: 'sent',
  atMs: 1, updatedMs: 1, note: '', repoState: 'none', repoSent: 0, repoError: null, ...over,
});

describe('byte counting', () => {
  it('counts UTF-8 bytes, not characters', () => {
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('你好')).toBe(6);
    expect(byteLength('😀')).toBe(4);
  });
  it('the limit is in bytes: 2,700 Chinese characters are over 8,000 bytes', () => {
    expect(passProblem(draft({ text: '字'.repeat(2_667) }))).toContain('too long');
    expect(passProblem(draft({ text: '字'.repeat(2_666) }))).toBeNull();
    expect(passProblem(draft({ text: 'a'.repeat(TEXT_MAX_BYTES) }))).toBeNull();
    expect(passProblem(draft({ text: 'a'.repeat(TEXT_MAX_BYTES + 1) }))).toContain('too long');
  });
  it('the summary has its own limit and only counts when it is on', () => {
    const long = 'a'.repeat(SUMMARY_MAX_BYTES + 1);
    expect(passProblem(draft({ summaryOn: true, summary: long }))).toContain('summary is too long');
    expect(passProblem(draft({ summaryOn: false, summary: long }))).toBeNull();
  });
});

describe('what blocks sending', () => {
  it('needs a person, a title and a text', () => {
    expect(passProblem(draft({ toMember: null }))).toContain('Pick who');
    expect(passProblem(draft({ title: '  ' }))).toContain('title');
    expect(passProblem(draft({ text: '' }))).toContain('Write what');
  });
  it('a repo needs the tick', () => {
    expect(passProblem(draft({ choice: 'repo' }))).toContain('I understand');
    expect(passProblem(draft({ choice: 'repo', understood: true }))).toBeNull();
  });
});

describe('why the repo choice is off', () => {
  const ok = { ok: true, name: 'potato', branch: 'main', reason: '' };
  it('says each reason plainly, in order', () => {
    expect(repoDisabledReason({ handoverOn: false, folder: '/x', check: ok, checking: false })).toContain('Allow repo hand-over');
    expect(repoDisabledReason({ handoverOn: true, folder: null, check: null, checking: false })).toContain('no project folder');
    expect(repoDisabledReason({ handoverOn: true, folder: '/x', check: null, checking: true })).toContain('Looking');
    expect(repoDisabledReason({ handoverOn: true, folder: '/x', check: { ok: false, name: '', branch: '', reason: 'Commit or stash first.' }, checking: false })).toBe('Commit or stash first.');
    expect(repoDisabledReason({ handoverOn: true, folder: '/x', check: ok, checking: false })).toBeNull();
  });
});

describe('lend choices', () => {
  const profile = (over: Partial<LendProfile>): LendProfile => ({ id: 'p', name: 'Work', agent_ids: ['claude'], account: { kind: 'main' }, who: 'teammates', member_ids: [], default_secs: 3600, max_secs: 4 * 3600, approval: 'each', sign_out_on_end: false, keep_awake: false, ...over });
  it('never offers more than the profile allows or 24 hours', () => {
    expect(lendChoices({ max_secs: 4 * 3600 })).toEqual([3600, 7200, 14400]);
    expect(lendChoices({ max_secs: 7 * 24 * 3600 })).toEqual([3600, 7200, 14400, 28800, 86400]);
  });
  it('only profiles for teammates, and only when lending is on', () => {
    const state = (enabled: boolean): LendState => ({ enabled, profiles: [profile({ id: 'a' }), profile({ id: 'b', who: 'my_pcs' }), profile({ id: 'c', member_ids: ['m-sam'] })], grants: [], requests_in: [], requests_out: [], drivers: [] });
    expect(lendableProfiles(state(true), 'm-maya').map((p) => p.id)).toEqual(['a']);
    expect(lendableProfiles(state(true), 'm-sam').map((p) => p.id)).toEqual(['a', 'c']);
    expect(lendableProfiles(state(false), 'm-maya')).toEqual([]);
    expect(lendableProfiles(null, null)).toEqual([]);
  });
});

describe('buttons by state', () => {
  it('maps a received task to its buttons', () => {
    expect(recvActions(recv({ state: 'new' }))).toEqual(['accept', 'decline']);
    expect(recvActions(recv({ state: 'seen' }))).toEqual(['accept', 'decline']);
    expect(recvActions(recv({ state: 'accepted' }))).toEqual(['start', 'done']);
    expect(recvActions(recv({ state: 'started' }))).toEqual(['done']);
    for (const s of ['done', 'declined', 'withdrawn'] as const) expect(recvActions(recv({ state: s }))).toEqual([]);
  });
  it('take back is offered until they start', () => {
    expect(['sent', 'seen', 'accepted'].every((s) => canTakeBack({ state: s as SentTask['state'] }))).toBe(true);
    expect(['started', 'done', 'declined', 'withdrawn'].some((s) => canTakeBack({ state: s as SentTask['state'] }))).toBe(false);
  });
  it('every sent state has a plain chip', () => {
    expect(sentChip('sent')).toBe('Sent');
    expect(sentChip('declined')).toBe('They said no');
    expect(sentChip('withdrawn')).toBe('You took it back');
  });
  it('the lend choice is offered only with an offer and lending on', () => {
    const lend = { profileId: 'p', profileName: 'Work', agentId: 'claude', secs: 7200 };
    expect(lendOffered({ lend }, true)).toBe(true);
    expect(lendOffered({ lend }, false)).toBe(false);
    expect(lendOffered({ lend: null }, true)).toBe(false);
  });
});

describe('lines', () => {
  const repo = { name: 'potato', branch: 'main', gitRef: 'x', history: 'latest' as const, bytes: 480 * 1024, sha256: 'h', chunks: 12 };
  it('repo progress while sending', () => {
    expect(sentRepoLine(sent({ repo, repoState: 'sending', repoSent: 3 }))).toBe('Sending the repo 3/12');
    expect(sentRepoLine(sent({ repo: null }))).toBeNull();
    expect(sentRepoLine(sent({ repo, repoState: 'failed', repoError: 'The link dropped.' }))).toBe('The link dropped.');
  });
  it('comes with', () => {
    expect(comesWith({ repo, lend: { profileId: 'p', profileName: 'Work', agentId: 'c', secs: 7200 } })).toBe('repo potato (480 KB, main) · Work for 2 hours');
    expect(comesWith({ repo: null, lend: null })).toBeNull();
  });
});

describe('the number on the Tasks tab', () => {
  it('counts received tasks that wait (new or seen) next to the review cards', () => {
    const view = { received: [recv({ id: 'a', state: 'new' }), recv({ id: 'b', state: 'seen' }), recv({ id: 'c', state: 'accepted' }), recv({ id: 'd', state: 'done' })] };
    expect(waitingCount(view)).toBe(2);
    expect(tabCounts(null, null, null, waitingCount(view)).tasks).toBe(2);
    expect(tabCounts(null, null, null).tasks).toBe(0);
    expect(waitingCount(null)).toBe(0);
  });
});
