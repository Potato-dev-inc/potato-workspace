// @vitest-environment jsdom
// "Add an agent": every screen of the one-box flow, driven by the mock runs (fake timers), plus the screen-level proof that
// the box is reachable from Settings > Agents.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actionButton, ERROR_COPY, type AddAgentApi, type AddAgentRun } from '../../../lib/addAgent';
import { chatCaps, mockAddAgentApi } from '../../../lib/addAgent.mocks';
import { SECTIONS } from '../catalog';
import { agentsRows } from '../sections/AgentsSection';
import { buttonByText, click, hasText, mountRows, settle, type as typeInto } from '../test-utils';
import { AddAgent, type AddAgentProps } from './AddAgent';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  globalThis.sessionStorage.clear();
});

const mount = async (api: AddAgentApi, props: Partial<AddAgentProps> = {}) => {
  await act(async () => root.render(<AddAgent api={api} {...props} />));
  await settle();
};
const text = () => host.textContent ?? '';
const input = () => host.querySelector('input[aria-label="Agent name"]') as HTMLInputElement;
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const addIt = async (value: string) => {
  await typeInto(input(), value);
  await click(buttonByText(host, 'Add'));
};
const chip = (key: string) => host.querySelector(`[data-chip="${key}"]`) as HTMLElement;
const chipMarkText = (key: string) => chip(key).querySelector('.aa-chip-mark')?.textContent;

/** An api whose start returns one fixed run. */
const fixed = (run: AddAgentRun): AddAgentApi => ({
  start: vi.fn(async () => run),
  status: vi.fn(async () => run),
  cancel: vi.fn(async () => ({ ...run, state: 'cancelled' as const })),
  approveInstall: vi.fn(async () => run),
  onProgress: vi.fn(async () => () => undefined),
});

const baseRun = (over: Partial<AddAgentRun>): AddAgentRun => ({
  run_id: 'r1',
  input: 'fakenat',
  agent_id: null,
  label: null,
  state: 'checking',
  started_ms: 1,
  steps: [],
  install: null,
  result: null,
  error: null,
  ...over,
});

describe('Add an agent', () => {
  it('adds a native agent in one click and shows chips', async () => {
    const api = mockAddAgentApi('native_ok');
    await mount(api);
    expect(host.querySelector('section[aria-label="Add an agent"]')).toBeTruthy();
    expect(text()).toContain('Or type a name, or paste its install command.');
    expect(buttonByText(host, 'Add')?.disabled).toBe(true);
    await addIt('fakenat');
    expect(text()).toContain('Adding');
    await advance(4000);
    expect(text()).toContain('Fakenat is ready.');
    expect(api.starts).toEqual([{ input: 'fakenat', terminalOnly: false }]);
    // one click: no install question, no second approval
    expect(buttonByText(host, 'Install Fakenat')).toBeUndefined();
    expect(host.querySelectorAll('[data-chip]').length).toBe(4);
    expect(text()).toContain('6 more fill in after your first chat');
    expect(chipMarkText('chat')).toBe('✓');
    expect(chipMarkText('resume')).toBe('✓');
    expect(chipMarkText('model_pick')).toBe('✓');
    expect(chipMarkText('images')).toBe('✕');
    expect(host.querySelector('[data-chip="stop"]')).toBeNull(); // not seen yet: counted in the text, no pill
    expect(buttonByText(host, 'Start a chat')).toBeTruthy();
    expect(buttonByText(host, 'Open in a terminal')).toBeTruthy();
  });

  it('never shows a tick for an unknown capability', async () => {
    const caps = chatCaps('fakenat', 'Fakenat');
    const unknown = { value: 'unknown' as const, source: 'unknown' as const, proof: '', at: null };
    // chat is Yes only because the handshake said so; every other chip is unknown and must not be upgraded.
    const bare = { ...caps, resume: unknown, model_pick: unknown, models: [], models_total: 0, images: unknown, level: 'l0' as const };
    const run = baseRun({ state: 'done', label: 'Fakenat', agent_id: 'fakenat', result: { agent_id: 'fakenat', label: 'Fakenat', mode: 'chat', caps: bare, sign_in_needed: false, already_added: false } });
    await mount(fixed(run));
    await addIt('fakenat');
    await settle();
    for (const el of host.querySelectorAll<HTMLElement>('[data-chip]')) {
      const mark = el.querySelector('.aa-chip-mark')?.textContent ?? '';
      if (el.dataset.value === 'unknown') expect(mark, el.dataset.chip).toBe('');
      else expect(mark).toMatch(/^[✓✕]$/);
    }
    expect(chipMarkText('chat')).toBe('✓');
    expect(host.querySelectorAll('[data-value="yes"]').length).toBe(1);
  });

  it('puts the chips the agent is known for first and the unknown ones under one caption', async () => {
    await mount(mockAddAgentApi('native_ok'));
    await addIt('fakenat');
    await advance(4000);
    const known = [...host.querySelectorAll('.aa-chips:not(.is-small) [data-chip]')].map((el) => (el as HTMLElement).dataset.chip);
    expect(known).toEqual(['chat', 'resume', 'model_pick', 'images']);
    // yes chips first, the no chip last; each shape carries its own value
    expect(chip('chat').dataset.value).toBe('yes');
    expect(chip('images').dataset.value).toBe('no');
    // The ones not seen yet are one line of text, never pills.
    expect(host.querySelectorAll('.aa-chips.is-small [data-chip]')).toHaveLength(0);
    expect(host.querySelector('.aa-caption')?.textContent).toBe('6 more fill in after your first chat');
    expect(text()).not.toContain('Not seen yet');
    // the hover text says where the answer came from
    expect(chip('chat').textContent).toContain('Fakenat said so');
  });

  it('draws all steps from the first frame with timers', async () => {
    await mount(mockAddAgentApi('handshake_silent'));
    await addIt('fakemute');
    const steps = () => [...host.querySelectorAll<HTMLElement>('.aa-step')].map((li) => `${li.dataset.step}:${li.dataset.state}`);
    // the whole plan is on screen at once, later lines pending
    expect(steps()).toEqual(['find:running', 'version:pending', 'chat_way:pending', 'handshake:pending', 'models:pending', 'save:pending']);
    expect(text()).toContain('Adding fakemute');
    expect(text()).toContain('Looking for fakemute on this computer');
    expect(text()).toContain('0 s (up to 2 s)');
    await advance(1400);
    expect(steps().slice(0, 4)).toEqual(['find:done', 'version:done', 'chat_way:done', 'handshake:running']);
    expect(text()).toContain('Adding Fakemute');
    expect(text()).toContain('Found Fakemute on this computer');
    expect(text()).toContain('It can chat');
    expect(text()).toContain('Saying hello to Fakemute');
    await advance(3000);
    expect(text()).toMatch(/[34] s \(up to 8 s\)/);
    // detail text never reaches the default path
    expect(text()).not.toContain('internal note');
  });

  it('shows the slow note after 15 seconds', async () => {
    await mount(mockAddAgentApi('slow'));
    await addIt('fakeslow');
    await advance(14000);
    expect(text()).not.toContain('Some agents start slowly. This is normal.');
    await advance(2000);
    expect(text()).toContain('Some agents start slowly. This is normal.');
    await advance(5000);
    expect(text()).toContain('Fakeslow is ready.');
    expect(text()).not.toContain('Some agents start slowly');
  });

  it('asks once before an install and shows what will run', async () => {
    const api = mockAddAgentApi('registry_addon');
    const approve = vi.spyOn(api, 'approveInstall');
    await mount(api);
    await addIt('fakereg');
    await advance(1500);
    expect(text()).toContain('Fakereg needs a small add-on to chat.');
    expect(text()).toContain('What will run');
    expect(text()).toContain('npm install --prefix add-ons/fakereg fakereg-acp@1.4.0');
    expect(host.querySelector('summary')?.textContent).toBe('What will run · from registry.npmjs.org');
    expect(text()).toContain('Without it, Fakereg works in a terminal only.');
    expect(buttonByText(host, 'Use it in a terminal instead')).toBeTruthy();
    expect(approve).not.toHaveBeenCalled();
    await click(buttonByText(host, 'Install the add-on'));
    expect(approve).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Installing Fakereg');
    await advance(4000);
    expect(text()).toContain('Fakereg is ready.');
    // no second question on the way
    expect(approve).toHaveBeenCalledTimes(1);
    expect(buttonByText(host, 'Install the add-on')).toBeUndefined();
  });

  it('shows the command to copy when Potato cannot install', async () => {
    const api = mockAddAgentApi('not_installed');
    const write = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    await mount(api);
    await addIt('fakegone');
    await advance(700);
    expect(text()).toContain('Fakegone is not on this computer yet.');
    expect(text()).toContain('Run this in a terminal, then check again.');
    expect(host.querySelector('.aa-cmd')?.textContent).toBe('npm install -g fakegone');
    expect(buttonByText(host, 'Install Fakegone')).toBeUndefined();
    await click(buttonByText(host, 'Copy'));
    expect(write).toHaveBeenCalledWith('npm install -g fakegone');
    await click(buttonByText(host, 'Check again'));
    expect(api.starts.length).toBe(2);
    expect(text()).toContain('Looking for fakegone on this computer');
    await advance(700);
    expect(text()).toContain('Run this in a terminal, then check again.');
  });

  it('terminal only agent lands on the terminal screen without chips', async () => {
    await mount(mockAddAgentApi('terminal_only'));
    await addIt('faketerm');
    await advance(2000);
    expect(text()).toContain('Faketerm works in a terminal window.');
    expect(text()).toContain('It cannot chat here.');
    expect(buttonByText(host, 'Open Faketerm')).toBeTruthy();
    expect(host.querySelectorAll('[data-chip]').length).toBe(0);
    expect(buttonByText(host, 'Start a chat')).toBeUndefined();
  });

  it.each(Object.entries(ERROR_COPY))('each failure shows one message and one action: %s', async (code, row) => {
    const message = row.message.replace('{Name}', 'Fakenat');
    const run = baseRun({ state: 'failed', label: 'Fakenat', error: { code, message, action: row.action, step: null } });
    await mount(fixed(run));
    await addIt('fakenat');
    await settle();
    expect(host.querySelector('.aa-title')?.textContent).toBe(message);
    expect(text()).not.toContain('ADD_');
    expect(host.querySelectorAll('.aa-step').length).toBe(0);
    const label = actionButton(row.action, 'Fakenat');
    const buttons = [...host.querySelectorAll('button')].map((b) => b.textContent);
    // Restart Potato has no app call behind it yet, so its button is not drawn
    if (label && row.action === 'show_install') expect(buttons).toEqual([label, 'Try again', 'Back']);
    else if (label && row.action !== 'restart_app') expect(buttons).toEqual([label, 'Back']);
    else expect(buttons).toEqual(['Back']);
  });

  it('use it in a terminal instead restarts as terminal only', async () => {
    const api = mockAddAgentApi('handshake_silent');
    await mount(api);
    await addIt('fakemute');
    await advance(9500);
    expect(text()).toContain('Fakemute did not answer in time.');
    await click(buttonByText(host, 'Use it in a terminal instead'));
    expect(api.starts[1]).toEqual({ input: 'fakemute', terminalOnly: true });
    await advance(2000);
    expect(text()).toContain('Fakemute works in a terminal window.');
  });

  it('cancel returns to the box and keeps the text', async () => {
    const api = mockAddAgentApi('cancelled');
    const cancel = vi.spyOn(api, 'cancel');
    await mount(api);
    await addIt('fakeslow');
    await advance(3000);
    await click(buttonByText(host, 'Cancel'));
    await settle();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Stopped. Nothing was added.');
    expect(input().value).toBe('fakeslow');
    await advance(20000);
    expect(text()).not.toContain('is ready.');
  });

  it('sign in note appears on the result', async () => {
    await mount(mockAddAgentApi('sign_in'));
    await addIt('fakeauth');
    await advance(4000);
    expect(text()).toContain('Fakeauth is added.');
    expect(text()).not.toContain('is ready.');
    // the sign-in line sits right under the title, before the chips
    const order = [...host.querySelectorAll('.aa-title, .aa-signin, .aa-chipwrap')].map((el) => el.className.split(' ')[0]);
    expect(order).toEqual(['aa-title', 'aa-signin', 'aa-chipwrap']);
    expect(host.querySelector('.aa-signin')?.textContent).toBe('Sign in first, then start a chat.');
    expect(host.querySelector('[data-chip="model_pick"]')).toBeNull();
    expect(buttonByText(host, 'Start a chat')).toBeTruthy();
  });

  it('status call restores a run after remount', async () => {
    const api = mockAddAgentApi('native_ok');
    const status = vi.spyOn(api, 'status');
    await mount(api);
    await addIt('fakenat');
    await advance(500);
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount(api);
    expect(status).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Adding Fakenat');
    await advance(4000);
    expect(text()).toContain('Fakenat is ready.');
  });

  it('Advanced holds the old wizard without the auto-answer switches', async () => {
    await mount(mockAddAgentApi('native_ok'));
    expect(text()).not.toContain('Capture wizard');
    await click(buttonByText(host, 'Advanced'));
    // the link says what it will do next, and the word is not repeated as a heading
    expect(buttonByText(host, 'Hide advanced')).toBeTruthy();
    expect(host.querySelector('.aa-adv-title')).toBeNull();
    expect(text()).toContain('Capture wizard');
    expect(text()).toContain('Import a file');
    expect(text()).toContain('Chat command');
    expect(text()).toContain('Details of the last add');
    await click(buttonByText(host, 'Capture wizard'));
    expect(host.querySelector('[role="dialog"]')).toBeTruthy();
    expect(host.querySelector('#wizard-command')).toBeTruthy();
    expect(host.querySelector('#wizard-finish-without-me')).toBeNull();
    expect(host.querySelector('#wizard-auto-answer')).toBeNull();
    expect(text()).not.toContain('Finish without me');
    expect(text()).not.toContain('Answer setup questions');
  });

  it('AddAgent is reachable from the Agents settings screen', async () => {
    // the first row of the Agents section is the box, and the section the person opens lists it
    const section = SECTIONS.find((s) => s.id === 'agents');
    expect(section?.rows.some((r) => r.id === 'add-agent')).toBe(true);
    expect(agentsRows[0].id).toBe('add-agent');
    const m = await mountRows([agentsRows[0]]);
    try {
      expect(m.host.querySelector('section[aria-label="Add an agent"]')).toBeTruthy();
      expect(hasText(m.host, 'Or type a name, or paste its install command.')).toBe(true);
      expect(m.host.querySelector('input[aria-label="Agent name"]')).toBeTruthy();
    } finally {
      await m.unmount();
    }
  });
});
