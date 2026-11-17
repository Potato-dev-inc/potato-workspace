// @vitest-environment jsdom
// The crew canvas through the real Settings screen (Labs "Crews" on): the page lists a ready-made crew, the canvas opens on
// it as boxes, a ready-made crew cannot be changed until the person saves a copy, the copy can be edited and saved, a task can
// be tried (a dry run), and the helpers can be kept ready. Only the desktop commands are faked.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel, type SettingsApi } from '../SettingsPanel';
import { BASE_SETTINGS, click, settle, type } from '../settings/test-utils';

const crew = {
  name: 'Our way',
  routing_file: 'difficulty.md',
  roles: [
    { id: 'lead', name: 'Lead', agent_type: 'claude', task: 'Lead the work.', hands_to: ['worker-easy', 'checker'], permissions: { read: true, write: 'scoped', write_scope: 'plans', run: 'ask', start_helpers: true, merge: true } },
    { id: 'worker-easy', name: 'Worker (easy)', agent_type: 'claude', model: 'haiku', task: 'Small tasks.', parent: 'lead', standbys: 2, permissions: { read: true, write: 'worktree', run: 'worktree', start_helpers: false, merge: false } },
    { id: 'worker-medium', name: 'Worker (medium)', agent_type: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', task: 'Several files.', parent: 'lead' },
    { id: 'checker', name: 'Checker', agent_type: 'claude', task: 'Check it.', parent: 'lead', check: true, hands_to: ['lead'], standbys: 1 },
  ],
};
const RULES = 'Easy -> worker-easy\n- Copy, style, empty states.\n';
const summary = (slug: string, name: string) => ({ slug, name, roles: 3, agents: ['claude'], problem: null });

let calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];
let saved: ReturnType<typeof summary>[] = [];
let applyAnswer: Record<string, unknown> = { added: ['a', 'b', 'c'], already: 0, skipped: [], needs_limit: null, problems: [] };
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    switch (command) {
      case 'crews_list':
        return saved;
      case 'crews_templates':
        return [summary('template:our-way', 'Our way')];
      case 'crews_agents':
        return { agents: [{ id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }], default: 'claude' };
      case 'crews_open': {
        const slug = String(args?.slug);
        return { slug, kind: slug.startsWith('template:') ? 'template' : 'saved', crew: slug.startsWith('template:') ? crew : { ...crew, name: 'My way' }, routing_text: RULES, problems: [] };
      }
      case 'crews_check':
        return [];
      case 'crews_save_canvas':
        saved = [summary('my-way', 'My way')];
        return { slug: 'my-way', errors: [] };
      case 'crews_try_task':
        return { route: { role: 'worker-easy', why: 'It fits the rules for Worker (easy) (copy, style).', fallback: false }, path: ['lead', 'worker-easy', 'checker'], needs_you: ['release'], others: [] };
      case 'crews_apply':
        return applyAnswer;
      case 'project_pick_folder':
        return { path: 'D:/work/app', name: 'app' };
      default:
        throw new Error(`not answered in this test: ${command}`);
    }
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

let host: HTMLDivElement;
let root: Root;
const api: SettingsApi = {
  load: async () => ({ ...BASE_SETTINGS, crews_enabled: true }),
  patch: async () => ({ ...BASE_SETTINGS, crews_enabled: true }),
  findBridgeUrl: async () => null,
  subscribe: () => () => {},
};

beforeEach(async () => {
  calls = [];
  saved = [];
  applyAnswer = { added: ['a', 'b', 'c'], already: 0, skipped: [], needs_limit: null, problems: [] };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<SettingsPanel open api={api} initialTab="helpers" initialRow="crews-page" />));
  for (let i = 0; i < 100 && !host.querySelector('.crews-page'); i++) await act(async () => new Promise((r) => setTimeout(r, 50)));
  await settle(10);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const text = () => document.body.textContent ?? '';
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const boxes = () => [...document.querySelectorAll<HTMLElement>('[data-testid="crew-box"]')];
const openTemplate = async () => {
  await click(button('Look at it'));
  await settle(10);
};

describe('the crew canvas, through the Settings screen', () => {
  it('lists the ready-made crew and opens it as one box per role', async () => {
    expect(host.querySelector('.crews-page')!.textContent).toContain('Ready-made crews');
    await openTemplate();
    expect(document.querySelector('[data-testid="crew-canvas"]')).not.toBeNull();
    expect(boxes().map((b) => b.querySelector('.crewc-box-name')!.textContent)).toEqual(['Lead', 'Worker (easy)', 'Worker (medium)', 'Checker']);
    expect(boxes()[0].textContent).toContain('Lead');
    expect(boxes()[1].textContent).toContain('Gets 2 ready now');
    expect(boxes()[2].textContent).toContain('DeepSeek V4.1 Flash');
    expect(boxes()[2].textContent).not.toContain('opencode-go/');
    expect(boxes()[3].textContent).toContain('Checks work');
    expect(button('Fit')).toBeDefined();
    expect(document.querySelector('.crewc-surface')!.getAttribute('data-zoom')).toBe('1');
    expect(document.querySelectorAll('path[data-edge]').length).toBeGreaterThanOrEqual(3);
    expect(text()).toContain('This is a ready-made crew. Make your own copy to change it.');
  });

  it('keeps a ready-made crew read-only until the person saves a copy, then edits the copy and saves it', async () => {
    await openTemplate();
    await click(boxes()[1]);
    const name = document.querySelector<HTMLInputElement>('[data-testid="role-editor"] input[type="text"]')!;
    expect(name.disabled).toBe(true);
    expect(button('Take this role out')).toBeUndefined();

    await click(button('Save my own copy'));
    await settle(10);
    expect(calls.find((c) => c.command === 'crews_save_canvas')!.args).toMatchObject({ replace: false, routingText: RULES });
    expect(text()).not.toContain('ready-made crew. Make your own copy');
    expect(document.querySelector('.crewc-title')!.textContent).toBe('My way');

    await click(boxes()[1]);
    const editable = document.querySelector<HTMLInputElement>('[data-testid="role-editor"] input[type="text"]')!;
    expect(editable.disabled).toBe(false);
    await type(editable, 'Quick worker');
    expect(boxes()[1].querySelector('.crewc-box-name')!.textContent).toBe('Quick worker');
    expect(text()).toContain('You have changes that are not saved.');
    expect(button('Get standbys ready now…')!.disabled).toBe(true);
    await click(button('Save'));
    await settle(10);
    const lastSave = calls.filter((c) => c.command === 'crews_save_canvas').pop()!;
    expect(lastSave.args).toMatchObject({ replace: true });
    expect((lastSave.args!.crew as { roles: Array<{ name: string }> }).roles[1].name).toBe('Quick worker');
  });

  it('adds a helper from the shared menu, and takes it out again', async () => {
    await openTemplate();
    await click(button('Save my own copy'));
    await settle(10);
    await click(button('Add a role'));
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent === 'Under Lead')!;
    expect(item).toBeDefined();
    await click(item);
    expect(boxes()).toHaveLength(5);
    expect(boxes()[4].querySelector('.crewc-box-name')!.textContent).toBe('Helper 1');
    await click(button('Take this role out'));
    expect(boxes()).toHaveLength(4);
  });

  it('pans the canvas when empty space is dragged, and a box drag does not pan', async () => {
    await openTemplate();
    const scroll = document.querySelector<HTMLElement>('[data-testid="crew-scroll"]')!;
    const mover = scroll.firstElementChild as HTMLElement;
    const fire = (el: Element, type: string, x: number, y: number) =>
      act(async () => {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
      });
    expect(mover.style.transform).toBe('translate(0px, 0px)');
    await fire(scroll, 'pointerdown', 100, 100);
    await fire(scroll, 'pointermove', 140, 125);
    await fire(scroll, 'pointerup', 140, 125);
    expect(mover.style.transform).toBe('translate(40px, 25px)');
    await fire(boxes()[0], 'pointerdown', 10, 10);
    await fire(boxes()[0], 'pointermove', 90, 90);
    await fire(boxes()[0], 'pointerup', 90, 90);
    expect(mover.style.transform).toBe('translate(40px, 25px)');
  });

  it('right-click on empty canvas shows app actions (add a role, zoom to fit), not a browser menu', async () => {
    await openTemplate();
    await click(button('Save my own copy'));
    await settle(10);
    const scroll = document.querySelector<HTMLElement>('[data-testid="crew-scroll"]')!;
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 60 });
    await act(async () => {
      scroll.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent);
    expect(items).toEqual(['Add a role', 'Zoom to fit']);
    await click([...document.querySelectorAll('[role="menuitem"]')][0]);
    expect(boxes()).toHaveLength(5);
  });

  it('moves a selected box with the arrow keys', async () => {
    await openTemplate();
    await click(button('Save my own copy'));
    await settle(10);
    const before = boxes()[1].style.left;
    await act(async () => {
      boxes()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(boxes()[1].style.left).not.toBe(before);
  });

  it('tries a task as a dry run, lights the way on the boxes and lets the person pick another role', async () => {
    await openTemplate();
    await click(button('Try a task'));
    const box = document.querySelector<HTMLTextAreaElement>('[data-testid="try-task"] textarea')!;
    await type(box, 'Fix the copy of the empty inbox and publish a release');
    await click(button('Show the way'));
    await settle(10);
    expect(calls.find((c) => c.command === 'crews_try_task')!.args).toMatchObject({ task: 'Fix the copy of the empty inbox and publish a release', routingText: RULES });
    expect([...document.querySelectorAll('[data-testid="try-path"] li')].map((li) => li.textContent)).toEqual(['Lead', 'Worker (easy)', 'Checker']);
    expect(boxes().filter((b) => b.classList.contains('is-on-path'))).toHaveLength(3);
    expect(text()).toContain('Needs you first: release');
    expect(text()).toContain('Nothing runs and nothing is sent');
    expect(calls.map((c) => c.command)).not.toContain('crews_start');

    const other = document.querySelector<HTMLSelectElement>('[data-testid="try-task"] select')!;
    await act(async () => {
      other.value = 'checker';
      other.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect([...document.querySelectorAll('[data-testid="try-path"] li')].map((li) => li.textContent)).toEqual(['Lead', 'Checker']);
  });

  it('gets the helpers ready now in a picked folder, and asks before raising the limit', async () => {
    await openTemplate();
    await click(button('Get standbys ready now…'));
    expect(document.querySelector('[role="dialog"][aria-labelledby="crewc-apply-t"]')!.textContent).toContain('3 standbys will be made ready now');
    expect(button('Get them ready')!.disabled).toBe(true);
    await click(button('Pick a folder…'));
    await settle(5);
    applyAnswer = { added: [], already: 0, skipped: [], needs_limit: 3, problems: [] };
    await click(button('Get them ready'));
    await settle(5);
    expect(calls.find((c) => c.command === 'crews_apply')!.args).toMatchObject({ folder: 'D:/work/app', raiseLimit: false });
    expect(text()).toContain('needs room for 3 standbys');
    applyAnswer = { added: ['a', 'b', 'c'], already: 0, skipped: [], needs_limit: null, problems: [] };
    await click(button('Raise the limit and get them ready'));
    await settle(5);
    expect(calls.filter((c) => c.command === 'crews_apply').pop()!.args).toMatchObject({ raiseLimit: true });
    expect(document.querySelector('[data-testid="apply-result"]')!.textContent).toContain('3 standbys were set up.');
  });
});
