// @vitest-environment jsdom
// Helper and lib texts in Traditional Chinese: the usage chip and tooltip, state words, ship hints, labels.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { t } from '../i18n';
import { useChinese, useEnglish, visibleEnglish } from '../i18n/test-utils';
import { stateText, spawnLogLine } from '../components/cockpit/model';
import { chipView } from '../components/cockpit/night/NightChip';
import { chipText, formatLeftLong, tooltip, totalsText, type UsageRow } from './usage';
import { checksSentence, stateHint } from './ship-model';
import { pickHint, startLabel, type PickResult } from './pick-for-me';
import { transcriptStreamLabel } from './transcript-labels';
import { groupByProject } from './sidebarProjects';
import { jobsRunning } from './pane-jobs';
import { placeTooltip } from './wsl-place';
import { helperChipText, startedByLabel } from './pane-helpers';

beforeEach(() => useChinese());
afterEach(() => useEnglish());

const NOW = 1_000_000_000_000;
const H = 3_600_000;
const row: UsageRow = {
  agent_id: 'codex', label: 'Codex CLI', account_id: null, account_label: null, state: 'ok', reason: null,
  windows: [{ name: '5-hour', used_percent: 87, resets_at_ms: NOW + 3 * H, reset_since: false }],
  plan: 'plus', observed_at_ms: NOW - 2 * H, limited_until_ms: null, page: 'https://example.test/u',
};
const shows = (s: string) => expect(visibleEnglish(Object.assign(document.createElement('div'), { textContent: s }), ['plus', 'hour'])).toEqual([]);

describe('lib texts in Traditional Chinese', () => {
  it('usage chip, durations and tooltip', () => {
    expect(chipText(row, NOW)).toBe(t('state.usage.pctUsedResets', { pct: 87, time: t('state.usage.hours', { count: 3 }) }));
    expect(chipText({ ...row, state: 'expired' }, NOW)).toBe(t('state.usage.signInExpired'));
    expect(chipText({ ...row, state: 'unknown' }, NOW)).toBe(t('state.usage.notShared'));
    expect(formatLeftLong(0)).toBe(t('state.usage.moment'));
    expect(totalsText({ today: { cost: 1.5, tokens: 2000 }, week: { cost: 3, tokens: 9000 }, models: [] })).toBe(t('state.usage.totalsToday', { cost: '$1.50', tokens: '2k' }));
    const tip = tooltip(row, NOW);
    expect(tip).toContain(t('state.usage.signIn', { name: t('state.usage.mainLogin') }));
    expect(tip).toContain(t('state.usage.openPage'));
    for (const line of tip.split('\n')) shows(line.replace(/token|Codex|CLI|5-hour/g, ''));
  });

  it('state words, spawn lines, background count, ship hints, labels', () => {
    expect([stateText('running'), stateText('waiting_input'), stateText('idle'), stateText('error'), stateText('exited')]).toEqual([t('state.working'), t('state.needsYou'), t('state.idle'), t('state.error'), t('state.exited')]);
    expect(spawnLogLine({ stage: 'spawning' } as never, 'Codex')).toBe(t('state.spawn.startingNamed', { name: 'Codex' }));
    expect(jobsRunning(1)).toBe(t('state.jobs.count', { count: 1 }));
    expect(stateHint('missing')).toBe(t('state.ship.missing'));
    expect(checksSentence(undefined)).toBe(t('state.ship.checking'));
    expect(pickHint('loading')).toBe(t('state.pick.looking'));
    expect(startLabel({ choice: { agentId: 'a', label: 'Codex' } } as PickResult)).toBe(t('state.pick.startNamed', { label: 'Codex' }));
    expect(transcriptStreamLabel('stderr')).toBe(t('state.stream.errors'));
    expect(groupByProject([1], () => null, [])[0].name).toBe(t('state.otherGroup'));
    expect(placeTooltip({ kind: 'linux', distro: 'Ubuntu', cwd: '/home/a' } as never)).toBe(t('state.place.runsIn', { distro: 'Ubuntu', cwd: '/home/a' }));
    expect(startedByLabel({ origin: { host: 'Claude' } })!.text).toBe(t('state.startedBy', { host: 'Claude' }));
    expect(helperChipText({ pane: { info: { id: 'a' }, status: 'idle' }, helpers: [{ pane: { info: { id: 'b' }, status: 'idle' }, helpers: [] }] })).toBe(t('state.helpers', { count: 1 }));
  });

  it('Night Shift chip lines', () => {
    const view = chipView({ enabled: true, settings: { stopHhmm: '07:00' }, run: { state: 'running', done: 3, total: 5, needsYou: 0, tasks: [], line: '' } } as never);
    expect(view!.text).toBe(t('state.night.running', { done: 3, total: 5, until: '07:00' }));
  });
});
