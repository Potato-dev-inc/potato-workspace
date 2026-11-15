// @vitest-environment jsdom
// The Shelf tab as a whole screen: TeamHost (the real parent) with a fake team API and a fake ShelfApi.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LendBackend } from '../../dev/lend-fixtures';
import { fakeShelfApi, RISKY_LINE, shelfState } from '../../dev/shelf-fixtures';
import { teamConfig, teamState } from '../../dev/team-fixtures';
import type { LendApi } from '../../lib/lend';
import type { ShelfApi, ShelfState } from '../../lib/shelf';
import type { TeamApi } from '../../lib/team';
import { resetRememberedTab } from './TeamPage';
import { TeamHost } from './TeamHost';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));
vi.mock('../../lib/openSettingsAt', () => ({ openSettingsAt: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  resetRememberedTab();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  host.remove();
});

const team = () =>
  ({
    state: async () => teamState({ presence: [] }),
    configGet: async () => teamConfig(),
    defaultName: async () => 'Leo',
    onChanged: async () => () => {},
    onDraft: async () => () => {},
  }) as unknown as TeamApi;
const lend = () => {
  const b = new LendBackend({ enabled: false });
  return { state: async () => b.get(), onChanged: async (cb: () => void) => b.on(cb), offers: async () => ({ answered: false, offers: [] }) } as unknown as LendApi;
};

async function show(shelf: ShelfApi) {
  await act(async () => root.render(<TeamHost api={team()} lendClient={lend()} shelfClient={shelf} />));
  await act(async () => {});
  await act(async () => {});
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="tab-shelf"]')!.click());
  await act(async () => {});
}
const $ = (sel: string) => host.querySelector<HTMLElement>(sel)!;
const btns = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent?.trim() === text);
const click = async (el: HTMLElement) => {
  await act(async () => el.click());
  await act(async () => {});
};
const tick = async (el: HTMLInputElement) => click(el);
const typeInto = async (el: HTMLInputElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const box = (label: string) => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((i) => i.closest('label')?.textContent?.includes(label))!;
const addBtn = () => btns('Add to my agents')[0];
const look = async (cardId: string) => click([...$(`[data-testid="shelf-suggested-${cardId}"]`).querySelectorAll('button')].find((b) => b.textContent === 'Look')!);

describe('Team page: Shelf', () => {
  it('shows the three blocks with data, who has what, and the tab number', async () => {
    await show(fakeShelfApi());
    expect($('[data-testid="shelf-block-suggested"]').textContent).toContain('Suggested to you');
    const notes = $('[data-testid="shelf-suggested-c-notes"]').textContent!;
    expect(notes).toContain('Release notes in simple English');
    expect(notes).toContain('Suggested by Maya');
    expect(notes).toContain('Short, clear release notes');
    expect(notes).toContain('Maya has it');
    expect($('[data-testid="shelf-suggested-c-linear"]').textContent).toContain('Needs your own key: LINEAR_API_KEY');
    expect($('[data-testid="shelf-block-recommended"]').textContent).toContain('Suggested by Maya, Leo');
    expect($('[data-testid="shelf-recommended-c-review"]').textContent).toContain('Added');
    expect($('[data-testid="shelf-recommended-c-browser"]').textContent).toContain('Maya, Leo, Sam have it');
    const mine = $('[data-testid="shelf-block-mine"]').textContent!;
    expect(mine).toContain('GitHub');
    expect(mine).toContain('Claude Code, Codex');
    expect(mine).toContain('Sent');
    // The tab number is `waiting`.
    expect($('[data-testid="tab-shelf"] .tpg-count').textContent).toBe('2');
  });

  it('with nothing on the shelf: one block, and its Invite a teammate button is the real invite (Setup here)', async () => {
    await show(fakeShelfApi(shelfState({ mine: [], suggested: [], recommended: [] })));
    const block = host.querySelector('[data-testid="shelf-empty"]')!;
    expect(block.querySelector('.ck-empty-title')!.textContent).toBe('Nothing on the shelf yet');
    expect(host.querySelector('[data-testid="shelf-block-mine"]')).toBeNull();
    expect(host.querySelector('[data-testid="shelf-block-suggested"]')).toBeNull();
    const invite = btns('Invite a teammate');
    expect(invite).toHaveLength(1);
    await click(invite[0]);
    // This fake team has no invite link: the real fallback is the Setup tab, not a dead button.
    expect(host.querySelector<HTMLButtonElement>('[data-testid="tab-setup"]')!.getAttribute('aria-selected')).toBe('true');
  });

  it('filters by Skills and Tools', async () => {
    await show(fakeShelfApi());
    await click(btns('Skills')[0]);
    expect($('[data-testid="shelf-tab"]').textContent).not.toContain('Postgres');
    expect($('[data-testid="shelf-tab"]').textContent).toContain('Review checklist');
    await click(btns('Tools')[0]);
    expect($('[data-testid="shelf-tab"]').textContent).toContain('Postgres');
    expect($('[data-testid="shelf-tab"]').textContent).not.toContain('Release notes in simple English');
  });

  it('Suggest: pick a person and a why line, Send calls suggest exactly, then the sent line shows', async () => {
    const api = fakeShelfApi();
    await show(api);
    await click(btns('Suggest to…')[1]);
    expect($('[data-testid="shelf-suggest-sheet"]').textContent).toContain('Only the definition goes. Keys, passwords and your folders do not.');
    expect($('[data-testid="shelf-suggest-sheet"]').textContent).toContain('GITHUB_TOKEN');
    expect(btns('Send')[0].disabled).toBe(true);
    await tick(box('Sam'));
    await typeInto($('[data-testid="shelf-suggest-sheet"] input[type="text"]') as HTMLInputElement, 'Handy for PRs');
    await click(btns('Send')[0]);
    expect(api.calls.filter((c) => c.startsWith('suggest'))).toEqual(['suggest("tool-github",["m-sam"],"Handy for PRs")']);
    expect($('[data-testid="shelf-sent-line"]').textContent).toBe('Suggested to Sam.');
    expect(api.calls.filter((c) => c.startsWith('suggest'))).toHaveLength(1);
  });

  it('Suggest to everyone sends an empty list and says the team', async () => {
    const api = fakeShelfApi();
    await show(api);
    await click(btns('Suggest to…')[0]);
    await tick(box('Everyone'));
    await click(btns('Send')[0]);
    expect(api.calls).toContain('suggest("skill-review",[],"")');
    expect($('[data-testid="shelf-sent-line"]').textContent).toBe('Suggested to the team.');
  });

  it('an item that cannot be shared has Suggest off and shows the reason', async () => {
    const api = fakeShelfApi();
    await show(api);
    const row = $('[data-testid="shelf-mine-tool-postgres"]');
    expect(row.textContent).toContain('The password is inside the command');
    const b = row.querySelector<HTMLButtonElement>('button')!;
    // Not a dead button: it is marked off, the reason is on screen (no tooltip), and a click answers with the reason.
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(b.title).toBe('');
    await click(b);
    expect(host.querySelector('[data-testid="shelf-suggest-sheet"]')).toBeNull();
    expect(row.querySelector('[role="alert"]')?.textContent).toContain('Cannot suggest this one: The password is inside the command');
    expect(row.querySelector('[data-testid^="shelf-install-"]')).toBeNull();
  });

  it('a tool that runs from a folder here offers the public install line instead, and only that line is sent', async () => {
    const api = fakeShelfApi();
    await show(api);
    const row = $('[data-testid="shelf-mine-local-tool-docs-1a2b3c4d"]');
    expect(row.textContent).toContain('It runs a program from a folder on your PC');
    await click(row.querySelector<HTMLButtonElement>('[data-testid^="shelf-install-"]')!);
    const sheet = $('[data-testid="shelf-suggest-sheet"]');
    expect(sheet.textContent).toContain('Only this public install line goes: npx -y @scope/docs-server. Nothing from your PC.');
    await tick(box('Sam'));
    await click(btns('Send')[0]);
    const sent = api.calls.filter((c) => c.startsWith('suggest'));
    expect(sent).toEqual(['suggest("aabbccddeeff001122334455",["m-sam"],"")']);
    // The id that goes is the install line's own: never the id of the tool that runs from a folder, and never a path.
    expect(sent[0]).not.toContain('local-tool-docs');
    expect(sent[0]).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//);
  });

  it('a tool with no public install line only shows its reason (no install button)', async () => {
    await show(fakeShelfApi());
    const row = $('[data-testid="shelf-mine-local-tool-pencil-9f8e7d6c"]');
    expect(row.textContent).toContain('It runs a program from a folder on your PC');
    expect(row.querySelector('[data-testid^="shelf-install-"]')).toBeNull();
  });

  it('Add: Look shows the writes, the path and the exact command line; Add sends the chosen agents', async () => {
    const api = fakeShelfApi();
    await show(api);
    await look('c-notes');
    expect($('[data-testid="shelf-add-sheet"]')).toBeTruthy();
    expect(api.calls).toContain('preview("c-notes",["claude","codex"])');
    const writes = host.querySelectorAll('[data-testid="shelf-write"]');
    expect(writes).toHaveLength(2);
    expect(writes[0].textContent).toContain('~/.claude/skills/skill-notes/SKILL.md');
    expect(writes[0].textContent).toContain('Will add');
    expect(writes[0].textContent).toContain('Write short notes.');
    // Take Codex off: the preview is asked again for one agent only.
    await tick(box('Codex'));
    expect(api.calls).toContain('preview("c-notes",["claude"])');
    expect(host.querySelectorAll('[data-testid="shelf-write"]')).toHaveLength(1);
    // A skill has no program line and no trust box.
    expect(host.querySelector('[data-testid="shelf-risk-shown"]')).toBeNull();
    await click(addBtn());
    expect(api.calls.filter((c) => c.startsWith('add'))).toEqual(['add("c-notes",["claude"],false)']);
    expect($('[data-testid="shelf-added-line"]').textContent).toBe('Added to Claude Code.');
  });

  it('the untrusted gate: the command shows in full, Add stays off until "I trust this" is ticked, then add is called with trusted=true', async () => {
    const api = fakeShelfApi();
    await show(api);
    await look('c-linear');
    expect($('[data-testid="shelf-risk-shown"]').textContent).toBe(RISKY_LINE);
    const text = $('[data-testid="shelf-add-sheet"]').textContent!;
    expect(text).toContain('This runs a program on your PC. Add it only if you trust Sam and know the program.');
    expect(text).toContain('It downloads and runs a package from the internet.');
    expect(text).toContain('Needs your own key: LINEAR_API_KEY. You add it yourself after adding.');
    expect(addBtn().disabled).toBe(true);
    await click(addBtn());
    expect(api.calls.filter((c) => c.startsWith('add'))).toEqual([]);
    await tick(box('I trust this'));
    expect(addBtn().disabled).toBe(false);
    await click(addBtn());
    expect(api.calls.filter((c) => c.startsWith('add'))).toEqual(['add("c-linear",["claude","codex"],true)']);
  });

  it('a tool that needs no trust is added with trusted=false and no tick', async () => {
    const api = fakeShelfApi();
    await show(api);
    await click(btns('Add')[0]); // Team recommends: Browser checks
    expect(box('I trust this')).toBeUndefined();
    expect(addBtn().disabled).toBe(false);
    await click(addBtn());
    expect(api.calls.filter((c) => c.startsWith('add'))).toEqual(['add("c-browser",["claude","codex"],false)']);
  });

  it('a suggestion from a newer build cannot be added', async () => {
    await show(fakeShelfApi());
    const c = $('[data-testid="shelf-suggested-c-future"]');
    expect(c.textContent).toContain('Needs a newer Potato Workspace');
    expect([...c.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Not for me']);
  });

  it('Not for me dismisses the card and reloads', async () => {
    const api = fakeShelfApi();
    await show(api);
    await click([...$('[data-testid="shelf-suggested-c-notes"]').querySelectorAll('button')].find((b) => b.textContent === 'Not for me')!);
    expect(api.calls).toContain('dismiss("c-notes")');
  });

  it('hostile text from a teammate is plain text: no element is created', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const base = shelfState();
    const state: ShelfState = { ...base, suggested: [{ ...base.suggested[1], name: evil, byName: evil, why: evil, shown: evil, risk: { ...base.suggested[1].risk!, shown: evil } }] };
    await show(fakeShelfApi(state));
    expect(host.querySelector('img')).toBeNull();
    expect($('[data-testid="shelf-suggested-c-linear"]').textContent).toContain(evil);
    await look('c-linear');
    expect(host.querySelector('img')).toBeNull();
    expect($('[data-testid="shelf-risk-shown"]').textContent).toBe(evil);
    expect(host.querySelector('a')).toBeNull();
  });

  it('Undo: shows after an add, calls undo with the token, and the sheet closes by itself after about 10 seconds', async () => {
    const api = fakeShelfApi();
    await show(api);
    await look('c-notes');
    await click(addBtn());
    await click(btns('Undo')[0]);
    expect(api.calls).toContain('undo("undo-token-1","skill-notes")');
    expect($('[data-testid="shelf-added-line"]').textContent).toBe('Taken back.');
  });

  it('the Add sheet closes by itself 10 seconds after an add', async () => {
    vi.useFakeTimers();
    const api = fakeShelfApi();
    await show(api);
    await look('c-notes');
    await click(addBtn());
    expect(btns('Undo')).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(10_100);
    });
    expect(host.querySelector('[data-testid="shelf-add-sheet"]')).toBeNull();
  });

  it('a backend sentence is shown when add fails', async () => {
    const api = fakeShelfApi(shelfState(), {
      add: async () => {
        throw 'That suggestion is not there any more.';
      },
    });
    await show(api);
    await look('c-notes');
    await click(addBtn());
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('That suggestion is not there any more.');
  });

  it('a backend that cannot answer shows one quiet line, not an error', async () => {
    await show(fakeShelfApi(shelfState(), { state: async () => Promise.reject(new Error('unknown command')) }));
    expect($('[data-testid="shelf-unavailable"]').textContent).toContain('not available');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect($('[data-testid="tab-shelf"]').querySelector('.tpg-count')).toBeNull();
  });
});
