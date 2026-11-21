// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { lendState, REQUEST_MAYA } from '../../dev/lend-fixtures';
import { teamConfig, teamState } from '../../dev/team-fixtures';
import { DEFAULT_SHARE, type PresenceView } from '../../lib/team';
import { initials, personHue } from './person-color';
import { busyLine, dayLabel, feedMatches, hereCount, linkStatus, linkWords, presenceKindOf, presenceWords, shareLine, shareOf, sidebarCount, sortPeople, tabCounts, tasksForMe, workingLine } from './team-page-model';

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
    expect(w('denied')).toBe('The team turned this computer away.');
    expect(linkWords(teamState({ enabled: false }))).toBe('Team is paused on this computer');
  });
});

describe('link status', () => {
  const detail = (o: object) => ({ host: 'relay.example.com', step: 'waiting' as const, attempting: false, problem: null, retryInS: null, ...o });
  it('spins only while a try is really going on', () => {
    const first = linkStatus(teamState({ link: 'connecting', linkDetail: detail({ step: 'socket', attempting: true }) }));
    expect(first.icon).toBe('busy');
    expect(first.reason).toContain('relay.example.com');
    expect(linkStatus(teamState({ link: 'connecting', linkDetail: detail({ step: 'idle' }) })).icon).toBe('idle');
    expect(linkStatus(teamState({ link: 'connecting' })).icon).toBe('idle');
  });
  it('says why it is offline, with a still icon, a retry countdown and Setup', () => {
    const s = linkStatus(teamState({ link: 'offline', linkDetail: detail({ problem: 'refused', retryInS: 2 }) }));
    expect(s.icon).toBe('warn');
    expect(s.title).toBe('Not connected to relay.example.com');
    expect(s.reason).toContain('did not answer');
    expect(s.reason).toContain('Trying again in 2 seconds.');
    expect(s.action).toBe('reconnect');
    expect(s.actionLabel).toBe('Try again');
    expect(linkStatus(teamState({ link: 'offline', linkDetail: detail({ problem: 'dns', attempting: true }) })).reason).toContain('Trying now.');
  });
  it('tells every kind of failure apart, in plain words, with the one button that fixes it', () => {
    const off = (problem: string, admin?: boolean) => linkStatus(teamState({ link: 'offline', linkDetail: detail({ problem }) }), { admin });
    expect(off('unknown_team', true).reason).toContain('has forgotten this team');
    expect(off('unknown_team', true).reason).toContain('Press the button to set the team up there again.');
    expect(off('unknown_team', true).actionLabel).toBe('Set the team up again');
    // A member cannot set the team up: the sentence says who can, and the button is only a retry.
    expect(off('unknown_team', false).reason).toContain('The team owner has to open Team');
    expect(off('unknown_team', false).actionLabel).toBe('Try again');
    expect(off('signature').reason).toContain('date or time on this computer');
    expect(off('busy').reason).toContain('too busy or full');
    expect(off('down').reason).toContain('having trouble on its side');
    expect(off('dns').reason).toContain('cannot find relay.example.com');
    for (const kind of ['unknown_team', 'signature', 'busy', 'down', 'dns', 'refused', 'timeout', 'tls', 'unreadable', 'other']) {
      expect(off(kind).problem).toBe(kind);
      expect(off(kind).action).toBe('reconnect');
      expect(off(kind).reason).not.toMatch(/{|undefined/);
    }
  });
  it('a gone relay is said once: no countdown, no Try again; the owner may move the team to a relay that works', () => {
    const gone = (admin: boolean, workingRelay: { address: string; host: string } | null, link: 'offline' | 'connecting' = 'offline') =>
      linkStatus(teamState({ link, linkDetail: detail({ problem: 'relay_gone', retryInS: 3 }) }), { admin, workingRelay });
    const w = { address: 'https://pm-relay.maya.workers.dev', host: 'pm-relay.maya.workers.dev' };
    const a = gone(true, w);
    expect(a.reason).toContain('The relay this team was saved on is gone.');
    expect(a.reason).not.toContain('Trying again');
    expect([a.action, a.moveTo, a.actionLabel]).toEqual(['move', w.address, 'Move this team to pm-relay.maya.workers.dev']);
    expect(gone(true, w, 'connecting').action).toBe('move');
    expect(gone(true, null).action).toBeNull();
    expect(gone(true, null).reason).toContain('Connect > Devices');
    expect(gone(false, w).action).toBeNull();
    expect(gone(false, w).reason).toContain('team owner');
  });
  it('a relay that turned this computer away has no button: only the team owner can add it again', () => {
    const denied = linkStatus(teamState({ link: 'denied', linkDetail: detail({}) }));
    expect(denied.action).toBeNull();
    expect(denied.reason).toContain('does not let this computer in');
  });
  it('shows a failed first try as a reason, not a spinner', () => {
    expect(linkStatus(teamState({ link: 'connecting', linkDetail: detail({ problem: 'timeout', retryInS: 1 }) })).icon).toBe('warn');
  });
  it('is honest when nothing is running or the relay says no', () => {
    const none = linkStatus(teamState({ link: null, transport: null }));
    expect(none.icon).toBe('warn');
    expect(none.title).toBe('The team connection is not running');
    expect(linkStatus(teamState({ link: 'denied' })).icon).toBe('bad');
    expect(linkStatus(teamState({ link: 'live' })).icon).toBe('ok');
    expect(linkStatus(teamState({ enabled: false })).icon).toBe('idle');
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
