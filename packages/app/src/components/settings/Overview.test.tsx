// @vitest-environment jsdom
// The Overview page's five cards, mounted for real with fake sources: names, honest failure, independence, actions.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANT_CHECK_YET } from '../../lib/setup-checks';
import { Overview, type OverviewSources } from './Overview';
import { fakeOverviewSources } from './overview-test-utils';
import { BASE_SETTINGS, click, settle } from './test-utils';

let host: HTMLDivElement;
let root: Root;
const openRow = vi.fn();
const openPage = vi.fn();

async function mount(sources: OverviewSources) {
  await act(async () => {
    root.render(<Overview settings={BASE_SETTINGS} bridgeUrl={null} openRow={openRow} openPage={openPage} sources={sources} />);
  });
  await settle(6);
}
const card = (id: string) => host.querySelector(`[data-card="${id}"]`) as HTMLElement;
const glyph = (id: string) => card(id).querySelector('.st-glyph')!.textContent;
const button = (id: string, label: string) => [...card(id).querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;

beforeEach(() => {
  openRow.mockClear();
  openPage.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('Overview cards', () => {
  it('shows the five cards: Agents, Signed in, Phone, Updates, Helpers', async () => {
    await mount(fakeOverviewSources());
    const names = [...host.querySelectorAll('.st-card')].map((c) => c.getAttribute('aria-label'));
    expect(names).toEqual(['Agents', 'Signed in', 'Phone', 'Updates', 'Helpers']);
    expect(card('agents').textContent).toContain('2 agents ready');
    expect(card('signed-in').textContent).toContain('Claude and Codex are signed in');
    expect(card('phone').textContent).toContain('1 phone paired');
    expect(card('updates').textContent).toContain('Up to date (1.0.19)');
    expect(card('helpers').textContent).toContain('Helpers show in a pane and stay open');
    for (const id of ['agents', 'signed-in', 'phone', 'updates', 'helpers']) expect(glyph(id)).toBe('✓');
  });

  it('says what needs a fix, with the first problem as the sub-line', async () => {
    await mount(
      fakeOverviewSources({
        checks: async () => [
          { id: 'agent-claude', status: 'ok', sentence: 'Claude is signed in', fix: null },
          { id: 'agent-gemini', status: 'warn', sentence: 'Gemini needs sign-in', fix: { kind: 'signin', label: 'Sign in', agentId: 'gemini' } },
        ],
      }),
    );
    expect(card('agents').textContent).toContain('1 to check');
    expect(card('agents').textContent).toContain('Gemini needs sign-in');
    expect(glyph('agents')).toBe('!');
  });

  it('a card whose source fails shows "Can\'t check this yet" and never a tick', async () => {
    await mount(
      fakeOverviewSources({
        checks: async () => {
          throw new Error('boom');
        },
        accounts: async () => {
          throw new Error('boom');
        },
        phones: async () => {
          throw new Error('boom');
        },
        update: async () => {
          throw new Error('no internet');
        },
        helpers: async () => {
          throw new Error('boom');
        },
      }),
    );
    for (const id of ['agents', 'signed-in', 'phone', 'updates', 'helpers']) {
      expect(card(id).textContent, id).toContain(CANT_CHECK_YET);
      expect(glyph(id), id).toBe('…');
      expect(card(id).textContent, id).not.toContain('✓');
    }
  });

  it('a check that could not read the agents is not a tick either', async () => {
    await mount(fakeOverviewSources({ checks: async () => [{ id: 'agents', status: 'warn', sentence: CANT_CHECK_YET, fix: null }] }));
    expect(card('agents').textContent).toContain(CANT_CHECK_YET);
    expect(glyph('agents')).toBe('…');
  });

  it('one slow card does not block the others', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<number>((r) => (release = () => r(2)));
    await mount(fakeOverviewSources({ phones: () => slow }));
    expect(card('phone').textContent).toContain('Checking');
    expect(glyph('phone')).toBe('…');
    expect(card('agents').textContent).toContain('2 agents ready');
    expect(card('updates').textContent).toContain('Up to date');
    await act(async () => release());
    await settle(3);
    expect(card('phone').textContent).toContain('2 phones paired');
  });

  it('each card action lands on the row the spec names', async () => {
    await mount(fakeOverviewSources({ phones: async () => 0, helpers: async () => ({ mode: 'always_show', keepOpen: true, connected: false }) }));
    await click(button('agents', 'Check my setup'));
    expect(openRow).toHaveBeenLastCalledWith('setup-check');
    await click(button('signed-in', 'Manage'));
    expect(openRow).toHaveBeenLastCalledWith('accounts');
    await click(button('phone', 'Pair a phone'));
    expect(openRow).toHaveBeenLastCalledWith('pairing');
    await click(button('updates', "What's new"));
    expect(openRow).toHaveBeenLastCalledWith('whats-new');
    // Not connected: the Helpers card offers Connect, which opens the agent-pack row.
    await click(button('helpers', 'Connect'));
    expect(openRow).toHaveBeenLastCalledWith('agent-pack');
  });

  it('Your phones, Update and Change go where the spec says', async () => {
    await mount(fakeOverviewSources({ update: async () => ({ currentVersion: '1.0.19', version: '1.0.20', notes: null }) }));
    expect(card('updates').textContent).toContain('1.0.20 is ready');
    await click(button('updates', 'Update'));
    expect(openRow).toHaveBeenLastCalledWith('version');
    await click(button('phone', 'Your phones'));
    expect(openRow).toHaveBeenLastCalledWith('paired-devices');
    await click(button('helpers', 'Change'));
    expect(openPage).toHaveBeenLastCalledWith('helpers');
  });

  it('Fix runs the first failing check\'s own fix', async () => {
    const signIn = vi.fn();
    await mount(
      fakeOverviewSources({
        checks: async () => [{ id: 'agent-gemini', status: 'warn', sentence: 'Gemini needs sign-in', fix: { kind: 'signin', label: 'Sign in', agentId: 'gemini' } }],
        actions: { signIn, installAddon: async () => undefined },
      }),
    );
    await click(button('agents', 'Sign in'));
    expect(signIn).toHaveBeenCalledWith('gemini');
  });
});
