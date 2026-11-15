// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { lendState, REQUEST_MAYA } from '../../dev/lend-fixtures';
import { teamConfig, teamState } from '../../dev/team-fixtures';
import { DEFAULT_SHARE, type PresenceView } from '../../lib/team';
import { initials, personHue } from './person-color';
import { busyLine, dayLabel, feedMatches, hereCount, linkWords, presenceKindOf, presenceWords, shareLine, shareOf, sidebarCount, sortPeople, tabCounts, tasksForMe, workingLine } from './team-page-model';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const pres = (member: string, over: Partial<PresenceView> = {}): PresenceView => ({ member, state: 'here', atMs: NOW - 10_000, sinceMs: NOW - 10 * MIN, project: null, title: null, running: 0, waiting: 0, ...over });

describe('presence words and kinds', () => {
  it('here, away with minutes, not here with last seen, and not here', () => {
    expect(presenceWords(pres('a'), NOW)).toBe('Here');
    expect(presenceWords(pres('a', { state: 'away', sinceMs: NOW - 12 * MIN }), NOW)).toBe('Away · 12 min');
    expect(presenceWords(pres('a', { atMs: NOW - 10 * MIN }), NOW)).toMatch(/^Not here · last seen \d\d:\d\d$/);
    expect(presenceWords(undefined, NOW)).toBe('Not here');
    expect(presenceWords(pres('a', { state: 'gone', atMs: 0 }), NOW)).toBe('Not here');
  });

  it('a state older than three minutes reads as not here', () => {
    expect(presenceKindOf(pres('a', { atMs: NOW - 181_000 }), NOW)).toBe('gone');
    expect(presenceKindOf(pres('a', { atMs: NOW - 179_000 }), NOW)).toBe('here');
  });
});

describe('people order', () => {
  it('me first, then here, away, not here', () => {
    const cfg = teamConfig();
    const people = sortPeople(cfg.members, [pres('m-sam', { state: 'away' }), pres('m-maya', { atMs: NOW - 10 * MIN })], NOW);
    expect(people.map((p) => p.member.name)).toEqual(['Leo', 'Sam', 'Maya']);
    expect(people.map((p) => p.kind)).toEqual(['here', 'away', 'gone']);
    expect(hereCount(people)).toBe(1);
  });
});

describe('what people share', () => {
  it('shows the project and title lines only when they are there', () => {
    expect(workingLine(pres('a'))).toBeNull();
    expect(workingLine(pres('a', { project: 'potato' }))).toBe('Working on potato');
    expect(workingLine(pres('a', { project: 'potato', title: 'Fix the sheet' }))).toBe('Working on potato · "Fix the sheet"');
    expect(workingLine(undefined)).toBeNull();
  });

  it('says how busy agents are, with the right plural', () => {
    expect(busyLine(pres('a'))).toBeNull();
    expect(busyLine(pres('a', { running: 2, waiting: 1 }))).toBe('2 agents running · 1 agent waits for an answer');
    expect(busyLine(pres('a', { running: 1 }))).toBe('1 agent running');
  });

  it('defaults to "here" only when the backend sends no share', () => {
    expect(shareOf(teamState())).toEqual(DEFAULT_SHARE);
    expect(DEFAULT_SHARE.level).toBe('here');
    expect(shareLine('here')).toContain('No project, no chat title');
    expect(shareLine('nothing')).toContain('Not here');
  });
});

describe('link words', () => {
  it('has words for every link state', () => {
    const w = (link: 'live' | 'polling' | 'connecting' | 'denied' | 'offline' | null) => linkWords(teamState({ link }));
    expect(w('live')).toBe('Connected');
    expect(w('polling')).toBe('Connected, checking every minute');
    expect(w('connecting')).toBe('Connecting…');
    expect(w(null)).toBe('Connecting…');
    expect(w('offline')).toBe('Not connected. Trying again.');
    expect(w('denied')).toBe("This team's relay said no. Open Setup.");
    expect(linkWords(teamState({ enabled: false }))).toBe('Team is paused on this computer');
  });
});

describe('what waits for me', () => {
  it('counts join requests (admin only), lend asks and tasks', () => {
    const lend = lendState({ requests_in: [REQUEST_MAYA] });
    const c = tabCounts(teamState(), teamConfig(), lend);
    expect(c.people).toBe(1);
    expect(c.usage).toBe(1);
    expect(tabCounts(teamState(), teamConfig({ admin: false }), null).people).toBe(0);
    expect(sidebarCount(teamConfig(), lend)).toBe(2);
    expect(sidebarCount(null, null)).toBe(0);
  });

  it('tasks are new review requests and notes', () => {
    const state = teamState();
    for (const card of tasksForMe(state.cards)) expect(['please_review', 'review_requested', 'note']).toContain(card.event.kind);
  });

  it('filters the feed', () => {
    const [push, pr] = teamState().cards;
    expect(feedMatches(push, 'pushes')).toBe(true);
    expect(feedMatches(pr, 'prs')).toBe(true);
    expect(feedMatches(pr, 'ci')).toBe(false);
    expect(feedMatches(push, 'all')).toBe(true);
  });

  it('labels days', () => {
    expect(dayLabel(NOW, NOW)).toBe('Today');
    expect(dayLabel(NOW - 86_400_000, NOW)).toBe('Yesterday');
  });
});

describe('person colour', () => {
  it('is stable for an id, one of six, and initials are letters', () => {
    expect(personHue('m-maya')).toBe(personHue('m-maya'));
    for (const id of ['a', 'b', 'm-leo', 'x'.repeat(40)]) expect(personHue(id)).toBeLessThan(6);
    expect(initials('Rudransh Garg')).toBe('RG');
    expect(initials('maya')).toBe('M');
    expect(initials('  ')).toBe('?');
  });
});
