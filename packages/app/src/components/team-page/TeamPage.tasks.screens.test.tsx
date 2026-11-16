// @vitest-environment jsdom
// Pass a task as whole screens: TeamHost (People and Tasks tabs) and the chat menu (Sidebar + PassTaskHost) with fake team, lend and
// tasks APIs. Only the desktop shell is faked. A teammate's text is planted with HTML and Markdown to prove it stays plain text.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import { LendBackend } from '../../dev/lend-fixtures';
import { teamConfig, teamState } from '../../dev/team-fixtures';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { LendApi, LendProfile } from '../../lib/lend';
import { registerNewAgentOpener } from '../../lib/newAgentRequest';
import type { PresenceView, TeamApi, TeamState } from '../../lib/team';
import { peekNewAgentDraft, takeNewAgentDraft } from '../../lib/team-pass-bridge';
import { EMPTY_TASKS, type PassInput, type RecvTask, type RepoCheck, type SentTask, type TasksView, type TeamTasksApi } from '../../lib/team-tasks';
import type { ShipApi } from '../../lib/ship-api';
import { Sidebar } from '../cockpit/Sidebar';
import { useLend } from '../lend/useLend';
import { PassTaskHost } from './PassTaskHost';
import { TeamHost } from './TeamHost';
import { resetRememberedTab } from './TeamPage';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));
vi.mock('../../lib/openSettingsAt', () => ({ openSettingsAt: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  resetRememberedTab();
  takeNewAgentDraft();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  registerNewAgentOpener(null);
});

const NOW = Date.now();
const pres = (member: string): PresenceView => ({ member, state: 'here', atMs: NOW - 5_000, sinceMs: NOW - 60_000, project: null, title: null, running: 0, waiting: 0 });

function teamFake(over: Partial<TeamState> = {}): TeamApi {
  return {
    state: async () => teamState({ presence: [pres('m-maya'), pres('m-sam')], cards: [], ...over }),
    configGet: async () => teamConfig(),
    defaultName: async () => 'Leo',
    onChanged: async () => () => {},
    onDraft: async () => () => {},
  } as unknown as TeamApi;
}

const profile = (over: Partial<LendProfile> = {}): LendProfile => ({
  id: 'p-work', name: 'Work account', agent_ids: ['claude'], account: { kind: 'main' }, who: 'teammates', member_ids: [], default_secs: 7200, max_secs: 4 * 3600, approval: 'each', sign_out_on_end: false, keep_awake: false, ...over,
});

function lendFake(enabled: boolean, profiles: LendProfile[] = []) {
  const b = new LendBackend({ enabled });
  b.state = { ...b.state, enabled, profiles };
  return {
    state: async () => b.get(),
    offers: async () => ({ answered: false, offers: [] }),
    onChanged: async (cb: () => void) => b.on(cb),
  } as unknown as LendApi;
}

const recv = (over: Partial<RecvTask> = {}): RecvTask => ({
  id: 'r1', fromMember: 'm-maya', fromName: 'Maya', fromDevice: 'd1', title: 'Fix the sheet', text: 'The address is cut at 320 px.', summary: '', repo: null, lend: null, state: 'new',
  atMs: NOW - 3 * 60_000, updatedMs: NOW - 3 * 60_000, risk: null, usage: 'theirs', lendError: null, repoState: 'none', repoGot: 0, repoError: null, unpacked: null, ...over,
});
const sent = (over: Partial<SentTask> = {}): SentTask => ({
  id: 's1', toMember: 'm-maya', toName: 'Maya', toDevices: [], answeredDevice: null, title: 'Check billing', text: 'Please look.', summary: '', repo: null, lend: null, lendUsed: false, state: 'sent',
  atMs: NOW - 60_000, updatedMs: NOW - 60_000, note: '', repoState: 'none', repoSent: 0, repoError: null, ...over,
});
const REPO = { name: 'potato-workspace', branch: 'main', gitRef: 'abc', history: 'latest' as const, bytes: 480 * 1024, sha256: 'h', chunks: 12 };

type Fake = TeamTasksApi & { calls: string[]; passed: PassInput[]; view: TasksView; check: RepoCheck };
function tasksFake(view: Partial<TasksView> = {}): Fake {
  const calls: string[] = [];
  const passed: PassInput[] = [];
  const f: Fake = {
    calls,
    passed,
    view: { ...EMPTY_TASKS, ...view },
    check: { ok: true, name: 'potato-workspace', branch: 'main', reason: '' },
    state: async () => f.view,
    pass: async (input) => {
      passed.push(input);
      calls.push('pass');
      return sent();
    },
    withdraw: async (id) => void calls.push(`withdraw(${id})`),
    seen: async (id) => void calls.push(`seen(${id})`),
    accept: async (id, input) => void calls.push(`accept(${id},${JSON.stringify(input)})`),
    decline: async (id) => void calls.push(`decline(${id})`),
    started: async (id) => void calls.push(`started(${id})`),
    done: async (id, note) => void calls.push(`done(${id},${JSON.stringify(note)})`),
    unpack: async (id, parent) => {
      calls.push(`unpack(${id},${parent})`);
      return `${parent}\\potato-workspace-1115`;
    },
    handoverSet: async (on) => void calls.push(`handoverSet(${on})`),
    repoCheck: async (path) => {
      calls.push(`repoCheck(${path})`);
      return f.check;
    },
    onChanged: async () => () => {},
  };
  return f;
}

async function show(tasks: Fake, opts: { lend?: LendApi; pick?: () => Promise<string | null>; team?: TeamApi } = {}) {
  await act(async () => root.render(<TeamHost api={opts.team ?? teamFake()} lendClient={opts.lend ?? lendFake(false)} tasksApi={tasks} pick={opts.pick} now={NOW} />));
  await act(async () => {});
  await act(async () => {});
}
const open = async (id: string) => {
  await act(async () => host.querySelector<HTMLButtonElement>(`[data-testid="tab-${id}"]`)!.click());
  await act(async () => {});
};
const btn = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
const click = async (el: HTMLElement | undefined | null) => {
  if (!el) throw new Error('nothing to click');
  await act(async () => el.click());
  await act(async () => {});
};
const q = <T extends HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
const handoverSwitch = () => q('handover-toggle')?.querySelector<HTMLButtonElement>('[role="switch"]') ?? null;
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('People card -> Pass a task', () => {
  it('opens the sheet with that person chosen, and send passes exactly what was typed (words only, their usage)', async () => {
    const tasks = tasksFake();
    await show(tasks);
    await click(q('pass-task-m-maya'));
    expect(q('pass-sheet')).not.toBeNull();
    expect((q<HTMLInputElement>('pass-who-m-maya')!.querySelector('input'))!.checked).toBe(true);
    // Not enabled until there is a title and a text.
    expect(q<HTMLButtonElement>('pass-send')!.disabled).toBe(true);
    expect(q('pass-send')!.textContent).toBe('Pass to Maya');
    await type(q<HTMLInputElement>('pass-title')!, 'Fix the sheet');
    await type(q<HTMLTextAreaElement>('pass-text')!, 'The address is cut at 320 px.');
    expect(q('pass-text-count')!.textContent).toBe('29 of 8,000 bytes');
    expect(q<HTMLButtonElement>('pass-send')!.disabled).toBe(false);
    await click(q('pass-send'));
    expect(tasks.passed).toEqual([{ toMember: 'm-maya', title: 'Fix the sheet', text: 'The address is cut at 320 px.', summary: '' }]);
    // The sheet closes after a send.
    expect(q('pass-sheet')).toBeNull();
  });

  it('the byte counter counts UTF-8 bytes and blocks a text that is too long', async () => {
    const tasks = tasksFake();
    await show(tasks);
    await click(q('pass-task-m-sam'));
    await type(q<HTMLInputElement>('pass-title')!, 'Long');
    await type(q<HTMLTextAreaElement>('pass-text')!, '字'.repeat(2_700));
    expect(q('pass-text-count')!.textContent).toBe('8,100 of 8,000 bytes');
    expect(q<HTMLButtonElement>('pass-send')!.disabled).toBe(true);
  });

  it('a failed send keeps the sheet and shows the backend sentence', async () => {
    const tasks = tasksFake();
    tasks.pass = async () => {
      throw 'Maya has not got this version yet.';
    };
    await show(tasks);
    await click(q('pass-task-m-maya'));
    await type(q<HTMLInputElement>('pass-title')!, 'T');
    await type(q<HTMLTextAreaElement>('pass-text')!, 'Body');
    await click(q('pass-send'));
    expect(q('pass-error')!.textContent).toContain('Maya has not got this version yet.');
    expect(q('pass-sheet')).not.toBeNull();
  });

  it('the repo choice is off, with the plain reason, while repo hand-over is off', async () => {
    const tasks = tasksFake({ handoverOn: false });
    await show(tasks, { pick: async () => '/work/potato' });
    await click(q('pass-task-m-maya'));
    expect(q<HTMLInputElement>('pass-repo')!.disabled).toBe(true);
    expect(q('pass-repo-why')!.textContent).toContain('Allow repo hand-over');
  });

  it('a folder that is not clean says why in the backend sentence', async () => {
    const tasks = tasksFake({ handoverOn: true });
    tasks.check = { ok: false, name: 'potato', branch: 'main', reason: 'Commit or stash first.' };
    await show(tasks, { pick: async () => '/work/potato' });
    await click(q('pass-task-m-maya'));
    await click(q('pass-pick'));
    expect(q<HTMLInputElement>('pass-repo')!.disabled).toBe(true);
    expect(q('pass-repo-why')!.textContent).toBe('Commit or stash first.');
  });

  it('the repo shows the own-risk box and send stays off until "I understand" is ticked; then the repo goes in the input (latest files by default)', async () => {
    const tasks = tasksFake({ handoverOn: true });
    await show(tasks, { pick: async () => '/work/potato' });
    await click(q('pass-task-m-maya'));
    await type(q<HTMLInputElement>('pass-title')!, 'Fix');
    await type(q<HTMLTextAreaElement>('pass-text')!, 'Please');
    await click(q('pass-pick'));
    expect(tasks.calls).toContain('repoCheck(/work/potato)');
    expect(q<HTMLInputElement>('pass-repo')!.disabled).toBe(false);
    expect(host.textContent).toContain('through your team connection, sealed so only their PC can read it. The most is 2 MB.');
    await click(q('pass-repo'));
    expect(q('repo-risk')!.textContent).toContain("You are sending a copy of your code to another person's PC. You cannot take it back.");
    expect(host.textContent).toContain('Only the latest files');
    expect(host.textContent).toContain('With all its history');
    expect(q<HTMLButtonElement>('pass-send')!.disabled).toBe(true);
    await click(q('repo-risk-tick'));
    expect(q<HTMLButtonElement>('pass-send')!.disabled).toBe(false);
    await click(q('pass-send'));
    expect(tasks.passed[0].repo).toEqual({ path: '/work/potato', history: 'latest', understood: true });
  });

  it('"Mine" lends a profile only when lending is on and I have a profile for teammates; the length is capped by the profile', async () => {
    const tasks = tasksFake({ lendOn: true });
    await show(tasks, { lend: lendFake(true, [profile()]) });
    await click(q('pass-task-m-maya'));
    await type(q<HTMLInputElement>('pass-title')!, 'Fix');
    await type(q<HTMLTextAreaElement>('pass-text')!, 'Please');
    await click(q('pass-usage-mine'));
    const secs = q<HTMLSelectElement>('pass-secs')!;
    expect([...secs.options].map((o) => o.value)).toEqual(['3600', '7200', '14400']);
    await click(q('pass-send'));
    expect(tasks.passed[0].lend).toEqual({ profileId: 'p-work', secs: 7200 });
  });

  it('no lend choice is enabled without a profile', async () => {
    const tasks = tasksFake({ lendOn: true });
    await show(tasks, { lend: lendFake(true, []) });
    await click(q('pass-task-m-maya'));
    expect(q<HTMLInputElement>('pass-usage-mine')!.disabled).toBe(true);
  });
});

describe('Tasks tab: For you', () => {
  it('shows a teammate\'s text as quoted plain text: planted HTML and Markdown make no elements', async () => {
    const evil = '<img src=x onerror=alert(1)> **bold** <script>window.hacked=1</script>';
    const tasks = tasksFake({ received: [recv({ title: '<b>Title</b>', text: evil, summary: '<i>sum</i> _it_' })] });
    await show(tasks);
    await open('tasks');
    const quote = q('task-text')!;
    expect(quote.tagName).toBe('BLOCKQUOTE');
    expect(quote.textContent).toBe(evil);
    expect(q('task-title')!.textContent).toBe('<b>Title</b>');
    expect(q('task-summary')!.textContent).toBe('<i>sum</i> _it_');
    const card = q('task-r1')!;
    expect(card.querySelector('img, script, strong b, b, i, em')).toBeNull();
    expect((window as unknown as { hacked?: number }).hacked).toBeUndefined();
  });

  it('long text is cut with Read all', async () => {
    const tasks = tasksFake({ received: [recv({ text: 'word '.repeat(200) })] });
    await show(tasks);
    await open('tasks');
    expect(q('task-text')!.textContent!.length).toBeLessThan(400);
    await click(btn('Read all'));
    expect(q('task-text')!.textContent!.length).toBeGreaterThan(900);
  });

  it('shows a calm risk line for a planted rm -rf, above the text', async () => {
    const tasks = tasksFake({ received: [recv({ text: 'Run rm -rf ~ to clean up.', risk: 'it deletes files' })] });
    await show(tasks);
    await open('tasks');
    const risk = q('task-risk')!;
    expect(risk.textContent).toBe('This task mentions something risky: it deletes files. Read it before you start.');
    expect(risk.compareDocumentPosition(q('task-text')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(q('task-text')!.textContent).toBe('Run rm -rf ~ to clean up.');
  });

  it('tells the sender "seen" once for a new task, and the tab shows the number', async () => {
    const tasks = tasksFake({ received: [recv(), recv({ id: 'r2', state: 'accepted' })] });
    await show(tasks);
    expect(host.querySelector('[data-testid="tab-tasks"] .tpg-count')!.textContent).toBe('1');
    await open('tasks');
    await act(async () => {});
    expect(tasks.calls.filter((c) => c.startsWith('seen('))).toEqual(['seen(r1)']);
  });

  it('Accept… with my own agent calls accept with usage theirs and no repo', async () => {
    const tasks = tasksFake({ received: [recv()] });
    await show(tasks);
    await open('tasks');
    await click(btn('Accept…'));
    expect(q<HTMLInputElement>('accept-own')!.checked).toBe(true);
    expect(q('accept-lent')).toBeNull();
    await click(q('accept-go'));
    expect(tasks.calls).toContain('accept(r1,{"usage":"theirs","wantRepo":false,"understood":false})');
  });

  it('the lent usage is offered only when the task has a lend offer and lending is on', async () => {
    const lend = { profileId: 'p', profileName: 'Claude', agentId: 'claude', secs: 7200 };
    // lend offer, lending on: offered.
    let tasks = tasksFake({ lendOn: true, received: [recv({ lend })] });
    await show(tasks);
    await open('tasks');
    expect(q('task-with')!.textContent).toBe('Comes with: Claude for 2 hours');
    await click(btn('Accept…'));
    expect(q('accept-lent')).not.toBeNull();
    expect(host.textContent).toContain("Use Maya's lent usage (Claude, 2 hours)");
    await click(q('accept-lent'));
    await click(q('accept-go'));
    expect(tasks.calls).toContain('accept(r1,{"usage":"lent","wantRepo":false,"understood":false})');
    // lend offer, lending off: not offered.
    act(() => root.unmount());
    root = createRoot(host);
    tasks = tasksFake({ lendOn: false, received: [recv({ lend })] });
    await show(tasks);
    await open('tasks');
    await click(btn('Accept…'));
    expect(q('accept-lent')).toBeNull();
  });

  it('a repo needs hand-over on, and its own-risk tick, before accept', async () => {
    let tasks = tasksFake({ handoverOn: false, received: [recv({ repo: REPO, repoState: 'offered' })] });
    await show(tasks);
    await open('tasks');
    expect(q('task-with')!.textContent).toBe('Comes with: repo potato-workspace (480 KB, main)');
    await click(btn('Accept…'));
    expect(q<HTMLInputElement>('accept-repo')!.disabled).toBe(true);
    expect(host.textContent).toContain('Allow repo hand-over');
    act(() => root.unmount());
    root = createRoot(host);
    tasks = tasksFake({ handoverOn: true, received: [recv({ repo: REPO, repoState: 'offered' })] });
    await show(tasks);
    await open('tasks');
    await click(btn('Accept…'));
    await click(q('accept-repo'));
    expect(q('repo-risk')!.textContent).toContain('You get code from another person. Nothing checks it.');
    expect(q('repo-risk')!.textContent).toContain('Do not run it until you read it.');
    expect(q<HTMLButtonElement>('accept-go')!.disabled).toBe(true);
    await click(q('repo-risk-tick'));
    await click(q('accept-go'));
    expect(tasks.calls).toContain('accept(r1,{"usage":"theirs","wantRepo":true,"understood":true})');
  });

  it('Decline needs no confirm', async () => {
    const tasks = tasksFake({ received: [recv()] });
    await show(tasks);
    await open('tasks');
    await click(btn('Decline'));
    expect(tasks.calls).toContain('decline(r1)');
  });

  it('an accepted task shows Start… and "Tell Maya it is done"; Start… only fills the New agent box, never sends', async () => {
    const tasks = tasksFake({ received: [recv({ state: 'accepted', summary: 'We were on the sheet.' })] });
    const opener = vi.fn();
    registerNewAgentOpener(opener);
    await show(tasks);
    await open('tasks');
    expect(btn('Start…')).toBeDefined();
    expect(btn('Tell Maya it is done')).toBeDefined();
    await click(btn('Start…'));
    expect(opener).toHaveBeenCalledTimes(1);
    expect(tasks.calls).toContain('started(r1)');
    // The words are only left for the page; no message was sent anywhere.
    expect(peekNewAgentDraft()).toEqual({ text: 'Fix the sheet\n\nThe address is cut at 320 px.\n\nWe were on the sheet.', folder: null, from: 'Maya' });
    expect(tasks.calls.some((c) => c.startsWith('pass') || c.startsWith('done('))).toBe(false);
  });

  it('Start… with no cockpit to open the page says so and starts nothing', async () => {
    const tasks = tasksFake({ received: [recv({ state: 'accepted' })] });
    await show(tasks);
    await open('tasks');
    await click(btn('Start…'));
    expect(q('task-error')!.textContent).toContain('Could not open the New agent page');
    expect(tasks.calls.some((c) => c.startsWith('started('))).toBe(false);
  });

  it('"Tell Maya it is done" opens an editable note first; nothing is sent until Send', async () => {
    const tasks = tasksFake({ received: [recv({ state: 'started' })] });
    await show(tasks);
    await open('tasks');
    await click(btn('Tell Maya it is done'));
    const note = q<HTMLTextAreaElement>('done-note')!;
    expect(note.value).toBe('');
    expect(tasks.calls.some((c) => c.startsWith('done('))).toBe(false);
    await type(note, 'Fixed in the sheet. Please check at 320 px.');
    expect(note.value).toBe('Fixed in the sheet. Please check at 320 px.');
    expect(tasks.calls.some((c) => c.startsWith('done('))).toBe(false);
    await click(q('done-send'));
    expect(tasks.calls).toContain('done(r1,"Fixed in the sheet. Please check at 320 px.")');
  });

  it('a note is at most 280 characters', async () => {
    const tasks = tasksFake({ received: [recv({ state: 'started' })] });
    await show(tasks);
    await open('tasks');
    await click(btn('Tell Maya it is done'));
    expect(q<HTMLTextAreaElement>('done-note')!.maxLength).toBe(280);
  });

  it('repo progress, Get the repo (picks a folder, says it is new and nothing ran), and a failed repo', async () => {
    let tasks = tasksFake({ received: [recv({ state: 'accepted', repo: REPO, repoState: 'receiving', repoGot: 3 })] });
    await show(tasks);
    await open('tasks');
    expect(q('recv-repo')!.textContent).toBe('Getting the repo 3/12');
    act(() => root.unmount());
    root = createRoot(host);
    tasks = tasksFake({ received: [recv({ state: 'accepted', repo: REPO, repoState: 'ready' })] });
    await show(tasks, { pick: async () => 'C:\\Documents\\Potato' });
    await open('tasks');
    await click(btn('Get the repo'));
    expect(tasks.calls).toContain('unpack(r1,C:\\Documents\\Potato)');
    expect(host.textContent).toContain('The repo is in a new folder: C:\\Documents\\Potato\\potato-workspace-1115. Nothing was run.');
    act(() => root.unmount());
    root = createRoot(host);
    tasks = tasksFake({ received: [recv({ state: 'accepted', repo: REPO, repoState: 'failed', repoError: 'The copy was damaged.' })] });
    await show(tasks);
    await open('tasks');
    expect(q('recv-repo')!.textContent).toBe('The copy was damaged.');
  });

  it('a lend that failed says so and offers my own agent instead', async () => {
    const tasks = tasksFake({ received: [recv({ state: 'accepted', usage: 'lent', lendError: 'The lent time ran out.' })] });
    await show(tasks);
    await open('tasks');
    expect(q('task-lend-error')!.textContent).toContain('The lent time ran out.');
    await click(btn('Use my own agent instead'));
    expect(tasks.calls.some((c) => c.includes('"usage":"theirs"'))).toBe(true);
  });

  it('a task that was taken back, and closed ones, are small rows', async () => {
    const tasks = tasksFake({ received: [recv({ id: 'a', state: 'withdrawn' }), recv({ id: 'b', state: 'declined', title: 'Old one' }), recv({ id: 'c', state: 'done', title: 'Finished one' })] });
    await show(tasks);
    await open('tasks');
    expect(q('task-a')!.textContent).toContain('Maya took this back.');
    expect(q('task-b')!.textContent).toContain('You said no');
    expect(q('task-c')!.textContent).toContain('Finished one');
    expect(q('task-a')!.className).toContain('tpg-task--closed');
  });
});

describe('Tasks tab: You passed', () => {
  it('shows a plain status chip for each state, the note they wrote on done as quoted text, and the repo progress', async () => {
    const tasks = tasksFake({
      sent: [
        sent({ id: 'a', state: 'sent', title: 'One' }),
        sent({ id: 'b', state: 'seen', title: 'Two' }),
        sent({ id: 'c', state: 'accepted', title: 'Three', repo: REPO, repoState: 'sending', repoSent: 4 }),
        sent({ id: 'd', state: 'started', title: 'Four' }),
        sent({ id: 'e', state: 'done', title: 'Five', note: '<b>All done</b> **yes**' }),
        sent({ id: 'f', state: 'declined', title: 'Six' }),
        sent({ id: 'g', state: 'withdrawn', title: 'Seven' }),
      ],
    });
    await show(tasks);
    await open('tasks');
    const chip = (id: string) => q(`sent-${id}`)!.querySelector('[data-testid="sent-chip"]')!.textContent;
    expect(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(chip)).toEqual(['Sent', 'Seen', 'Accepted', 'Started', 'Done', 'They said no', 'You took it back']);
    expect(q('sent-c')!.querySelector('[data-testid="sent-repo"]')!.textContent).toBe('Sending the repo 4/12');
    expect(q('sent-note')!.textContent).toBe('<b>All done</b> **yes**');
    expect(q('sent-e')!.querySelector('b')).toBeNull();
  });

  it('Take back asks first, then withdraws; it is offered only before they start', async () => {
    const tasks = tasksFake({ sent: [sent({ id: 'a', state: 'seen' }), sent({ id: 'b', state: 'started', title: 'Begun' })] });
    await show(tasks);
    await open('tasks');
    expect(q('sent-b')!.textContent).not.toContain('Take back');
    await click([...q('sent-a')!.querySelectorAll('button')].find((b) => b.textContent === 'Take back'));
    expect(q('takeback-confirm')!.textContent).toContain('Take this back from Maya?');
    expect(tasks.calls.some((c) => c.startsWith('withdraw('))).toBe(false);
    await click(q('takeback-yes'));
    expect(tasks.calls).toContain('withdraw(a)');
  });

  it('the empty words, and the repo switch asks before it turns on', async () => {
    const tasks = tasksFake();
    await show(tasks);
    await open('tasks');
    expect(q('tasks-empty')!.textContent).toBe("Nothing passed around yet. Pass a task from a person's card, or from any chat's menu.");
    // the hand-over switch is the same Switch as elsewhere on Connect (a role="switch" button, not a checkbox)
    expect(q('handover-toggle')!.querySelector('input[type="checkbox"]')).toBeNull();
    expect(handoverSwitch()!.getAttribute('aria-checked')).toBe('false');
    await click(handoverSwitch()!);
    expect(q('handover-confirm')).not.toBeNull();
    expect(tasks.calls.some((c) => c.startsWith('handoverSet'))).toBe(false);
    await click(q('handover-yes'));
    expect(tasks.calls).toContain('handoverSet(true)');
  });

  it('turning the repo switch off needs no question', async () => {
    const tasks = tasksFake({ handoverOn: true });
    await show(tasks);
    await open('tasks');
    expect(handoverSwitch()!.getAttribute('aria-checked')).toBe('true');
    await click(handoverSwitch()!);
    expect(tasks.calls).toContain('handoverSet(false)');
  });
});

// ---- the chat menu -----------------------------------------------------------------------------------------------

function cockpitFake(): CockpitApi {
  const info = { id: 'p1', agent_type: 'codex', pid: 1, status: 'idle', created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 80, rows: 24, title: null } as unknown as PaneInfo;
  const pane = { info, status: 'idle' };
  return {
    registry: { paneList: [pane], panes: new Map([['p1', pane]]), initialReady: true },
    names: new Map([['p1', 'Codex']]),
    asked: { questions: [] },
    launchEntries: [],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: 'p1',
    select: vi.fn(),
    interrupt: vi.fn(async () => {}),
    prompts: {},
    statusSince: new Map([['p1', 0]]),
    now: 60_000,
    spawn: null,
    toasts: [],
    notify: vi.fn(),
    bridgeLine: '',
  } as unknown as CockpitApi;
}
const ship = {
  recent: vi.fn(async () => []),
  gitState: vi.fn(async () => 'repo'),
  gitInitPlan: vi.fn(),
  gitInit: vi.fn(),
  forget: vi.fn(),
  pickFolder: vi.fn(),
} as unknown as ShipApi;

const offLend = lendFake(false);
const offTeam = teamFake();
function Cockpit({ canPass, tasks }: { canPass: boolean; tasks: Fake }) {
  const lend = useLend(offLend);
  return (
    <>
      <Sidebar c={cockpitFake()} onOpenPalette={() => {}} ship={ship} canPassTask={canPass} />
      <PassTaskHost api={offTeam} tasksApi={tasks} teamState={null} lend={lend} />
    </>
  );
}
const rightClick = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
const rowCodex = () => [...host.querySelectorAll<HTMLButtonElement>('button.ck-row')].find((b) => b.querySelector('.ck-row-title')?.textContent === 'Codex')!;
const menuItem = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent!.replace('⌃C', '') === label);

describe('the chat menu', () => {
  it('has "Pass to a teammate…" when a team is on; it opens the sheet with the chat folder, ready to pick the repo', async () => {
    const tasks = tasksFake({ handoverOn: true });
    await act(async () => root.render(<Cockpit canPass tasks={tasks} />));
    await act(async () => {});
    await act(async () => rightClick(rowCodex()));
    expect(menuItem('Pass to a teammate…')).toBeDefined();
    await click(menuItem('Pass to a teammate…'));
    await act(async () => {});
    expect(q('pass-sheet')).not.toBeNull();
    expect(q('pass-folder')!.textContent).toBe('C:\\work\\shop');
    expect(tasks.calls).toContain('repoCheck(C:\\work\\shop)');
    // The chat's folder can be sent: the repo choice is on, nobody is chosen yet.
    expect(q<HTMLInputElement>('pass-repo')!.disabled).toBe(false);
    expect(q<HTMLButtonElement>('pass-send')!.disabled).toBe(true);
  });

  it('is hidden when there is no team', async () => {
    await act(async () => root.render(<Cockpit canPass={false} tasks={tasksFake()} />));
    await act(async () => {});
    await act(async () => rightClick(rowCodex()));
    expect(menuItem('Pass to a teammate…')).toBeUndefined();
    expect(menuItem('Rename')).toBeDefined();
  });
});
