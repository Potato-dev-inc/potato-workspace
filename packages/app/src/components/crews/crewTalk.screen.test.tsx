// @vitest-environment jsdom
// "Change the crew by talking", through the real Settings screen and the real crew canvas: the front desk's proposal is shown before and
// after on the canvas, nothing changes until Apply, Undo puts it back, and a change that is not routing is refused. Only the desktop
// commands are faked (the real refusal rules are tested in Rust: crews/talk_tests.rs).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel, type SettingsApi } from '../SettingsPanel';
import { BASE_SETTINGS, click, settle, type } from '../settings/test-utils';

const crew = {
  name: 'Our way',
  roles: [
    { id: 'lead', name: 'Lead', agent_type: 'claude', task: 'Lead the work.', hands_to: ['worker-easy', 'checker'] },
    { id: 'worker-easy', name: 'Worker (easy)', agent_type: 'claude', model: 'haiku', task: 'Small tasks.', parent: 'lead' },
    { id: 'worker-medium', name: 'Worker (medium)', agent_type: 'claude', task: 'Several files.', parent: 'lead' },
    { id: 'checker', name: 'Checker', agent_type: 'claude', task: 'Check it.', parent: 'lead', check: true, hands_to: ['lead'] },
  ],
};
const RULES = 'Easy -> worker-easy\n- Copy, style, empty states.\n';
const RULES_AFTER = 'Easy -> worker-easy\n- Copy, style, empty states.\n- Test fixes.\n';
const summary = (slug: string, name: string) => ({ slug, name, roles: 4, agents: ['claude'], problem: null });

// Lead stops handing to the easy worker; the easy worker hands to the medium one; a rule is added.
const proposed = {
  status: 'proposal',
  message: 'Test fixes go to the easy worker, and it hands on to the medium one.',
  code: null,
  crew: {
    ...crew,
    roles: crew.roles.map((r) => {
      if (r.id === 'lead') return { ...r, hands_to: ['checker'] };
      if (r.id === 'worker-easy') return { ...r, hands_to: ['worker-medium'] };
      return r;
    }),
  },
  routing_text: RULES_AFTER,
  changes: [
    { kind: 'handoff_removed', from: 'lead', to: 'worker-easy' },
    { kind: 'handoff_added', from: 'worker-easy', to: 'worker-medium' },
    { kind: 'rule_added', role: 'worker-easy', text: 'Test fixes.' },
  ],
  asked: 'claude',
};
const refused = {
  status: 'refused',
  message: 'The front desk can only change who hands work to whom, and the routing rules. This change was about a model. Change that on the role\'s own page.',
  code: 'CREW_TALK_NOT_ROUTING',
  crew: null,
  routing_text: null,
  changes: [],
  asked: 'claude',
};

let calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];
let answer: Record<string, unknown> = proposed;
let savedCrew: unknown = null;
let savedRules = RULES;
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    switch (command) {
      case 'crews_list':
        return [];
      case 'crews_templates':
        return [summary('template:our-way', 'Our way')];
      case 'crews_agents':
        return { agents: [{ id: 'claude', label: 'Claude' }], default: 'claude' };
      case 'crews_open': {
        const slug = String(args?.slug);
        return { slug, kind: slug.startsWith('template:') ? 'template' : 'saved', crew: slug.startsWith('template:') ? crew : (savedCrew ?? { ...crew, name: 'My way' }), routing_text: slug.startsWith('template:') ? RULES : savedRules, problems: [] };
      }
      case 'crews_check':
        return [];
      case 'crews_save_canvas':
        savedCrew = args?.crew;
        savedRules = String(args?.routingText);
        return { slug: 'my-way', errors: [] };
      case 'crews_talk':
        return answer;
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
  answer = proposed;
  savedCrew = null;
  savedRules = RULES;
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
const lines = () => document.querySelectorAll('path[data-edge]').length;
const thick = () => [...document.querySelectorAll('path.is-changed')];
const copyAndTalk = async () => {
  await click(button('Look at it'));
  await settle(10);
  await click(button('Save my own copy'));
  await settle(10);
  await click(button('Talk'));
};
const ask = async (words: string) => {
  await type(document.querySelector<HTMLTextAreaElement>('[data-testid="talk-to-crew"] textarea')!, words);
  await click(button('Ask the front desk'));
  await settle(10);
};

describe('change the crew by talking, through the Settings screen', () => {
  it('shows the proposal before and after on the canvas, and changes nothing until Apply', async () => {
    await copyAndTalk();
    const before = lines();
    await ask('send test fixes to the easy worker');

    expect(calls.find((c) => c.command === 'crews_talk')!.args).toMatchObject({ request: 'send test fixes to the easy worker', routingText: RULES });
    const panel = document.querySelector('[data-testid="talk-proposal"]')!;
    expect(panel.textContent).toContain('Lead will no longer hand work to Worker (easy).');
    expect(panel.textContent).toContain('Worker (easy) will hand work to Worker (medium).');
    expect(panel.textContent).toContain('New rule for Worker (easy): "Test fixes."');
    expect(panel.querySelector('.crewc-ruledif .is-added')!.textContent).toBe('+ Test fixes.');

    // After: the new line is drawn on the canvas, thick, and the box whose rules change is marked.
    expect(thick().map((p) => p.getAttribute('data-edge'))).toEqual(['hands']);
    expect(lines()).toBe(before + 1);
    expect(document.querySelectorAll('.crewc-box.is-touched')).toHaveLength(1);
    expect(button('After')!.getAttribute('aria-pressed')).toBe('true');

    // Before: the crew as it is, the line that goes away is thick.
    await click(button('Before'));
    expect(button('Before')!.getAttribute('aria-pressed')).toBe('true');
    expect(thick()).toHaveLength(1);
    expect(lines()).toBe(before);
    expect(document.querySelectorAll('[data-testid="crew-box"]')).toHaveLength(4);

    // Nothing was applied: no unsaved changes, no save call, and Apply is still waiting.
    expect(text()).not.toContain('You have changes that are not saved.');
    expect(calls.filter((c) => c.command === 'crews_save_canvas')).toHaveLength(1); // only the copy
    expect(button('Apply')).toBeDefined();
  });

  it('applies on the canvas when the person presses Apply, and Undo puts it back', async () => {
    await copyAndTalk();
    const before = lines();
    await ask('send test fixes to the easy worker');
    await click(button('Apply'));
    await settle(5);

    expect(document.querySelector('[data-testid="talk-proposal"]')).toBeNull();
    expect(thick()).toHaveLength(0);
    expect(text()).toContain('You have changes that are not saved.');
    expect(document.querySelector('[data-testid="talk-note"]')!.textContent).toContain('Applied on the canvas. Press Save to keep it.');
    // the crew on the canvas is now the proposed one (the new hand-off exists), and nothing was saved yet
    expect(lines()).toBe(before + 1);
    expect(calls.filter((c) => c.command === 'crews_save_canvas')).toHaveLength(1);

    await click(button('Save'));
    await settle(10);
    const saved = calls.filter((c) => c.command === 'crews_save_canvas').pop()!.args as { crew: { roles: Array<{ id: string; hands_to?: string[] }> }; routingText: string };
    expect(saved.crew.roles.find((r) => r.id === 'worker-easy')!.hands_to).toEqual(['worker-medium']);
    expect(saved.routingText).toBe(RULES_AFTER);

    // Undo is for the last change: put back the crew and its rules as they were.
    await click(button('Undo'));
    await settle(5);
    expect(text()).toContain('Put back as it was.');
    expect(text()).toContain('You have changes that are not saved.');
    await click(button('Save'));
    await settle(10);
    const back = calls.filter((c) => c.command === 'crews_save_canvas').pop()!.args as { crew: { roles: Array<{ id: string; hands_to?: string[] }> }; routingText: string };
    expect(back.crew.roles.find((r) => r.id === 'worker-easy')!.hands_to).toBeUndefined();
    expect(back.routingText).toBe(RULES);
  });

  it('refuses a change that is not routing, with the plain reason, and offers no Apply', async () => {
    answer = refused;
    await copyAndTalk();
    await ask('make the easy worker use Opus');
    expect(document.querySelector('[data-testid="talk-refused"]')!.textContent).toContain('can only change who hands work to whom');
    expect(document.querySelector('[data-testid="talk-proposal"]')).toBeNull();
    expect(button('Apply')).toBeUndefined();
    expect(text()).not.toContain('You have changes that are not saved.');
    expect(thick()).toHaveLength(0);
  });

  it('keeps "Not now" harmless: the canvas goes back to the crew as it is', async () => {
    await copyAndTalk();
    await ask('send test fixes to the easy worker');
    expect(thick()).toHaveLength(1);
    await click(button('Not now'));
    expect(thick()).toHaveLength(0);
    expect(document.querySelector('[data-testid="talk-proposal"]')).toBeNull();
    expect(text()).not.toContain('You have changes that are not saved.');
  });

  it('cannot be used on a ready-made crew until the person makes a copy', async () => {
    await click(button('Look at it'));
    await settle(10);
    await click(button('Talk'));
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid="talk-to-crew"] textarea')!.disabled).toBe(true);
    expect(button('Ask the front desk')!.disabled).toBe(true);
    expect(calls.map((c) => c.command)).not.toContain('crews_talk');
  });
});
