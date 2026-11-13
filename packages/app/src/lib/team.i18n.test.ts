// @vitest-environment jsdom
// Bring my chats reasons and the Team card wording in Traditional Chinese: read from the dictionary, no English left.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { t } from '../i18n';
import { useChinese, useEnglish, visibleEnglish } from '../i18n/test-utils';
import { missingReason } from '../components/history/BringAgentList';
import { cardTitle, friendlyBranch, jobTitle, mergeWork, reviewRequest, type TeamEvent, type TeamJob } from './team';

beforeEach(() => useChinese());
afterEach(() => useEnglish());

const shows = (s: string) => expect(visibleEnglish(Object.assign(document.createElement('div'), { textContent: s }), ['Maya', 'main', 'invoices'])).toEqual([]);

describe('Bring my chats and Team cards in Traditional Chinese', () => {
  it('says why an agent has nothing to bring', () => {
    expect(missingReason('not_installed', true)).toBe(t('bring.notInstalled'));
    expect(missingReason('signed_out', true)).toBe(t('bring.signedOut'));
    expect(missingReason('unknown', true)).toBe(t('bring.noChats'));
    expect(missingReason('unknown', false)).toBe(t('bring.cantRead'));
    for (const reason of ['not_installed', 'signed_out', 'unknown'] as const) shows(missingReason(reason, true));
    shows(missingReason('unknown', false));
  });

  it('review request and merge wording', () => {
    expect(reviewRequest(142)).toBe(t('team.reviewRequest', { n: 142 }));
    expect(friendlyBranch('feat/invoices')).toBe('invoices');
    const event = {
      kind: 'pr_merged', actor: { display: 'Maya' }, project: { key: 'github.com/acme/app', name: 'app' },
      subject: { pr: { number: 7 }, base: 'main' },
    } as unknown as TeamEvent;
    expect(cardTitle(event)).toBe(t('team.mergedInto', { who: 'Maya', what: reviewRequest(7), base: 'main' }));
    shows(cardTitle(event).replace('acme', ''));
    const job = { state: 'waiting', theirBranch: 'feat/invoices', into: 'main', conflicts: [] } as unknown as TeamJob;
    expect(mergeWork(job)).toBe(t('team.mergeWork', { from: 'invoices', to: 'main' }));
    expect(jobTitle(job)).toBe(t('team.job.queued', { work: mergeWork(job) }));
    shows(jobTitle(job));
  });
});
