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
  it('shows four cards: Agents, Signed in, Updates, Helpers (the phone is on the Connect page)', async () => {
    await mount(fakeOverviewSources());
    const names = [...host.querySelectorAll('.st-card')].map((c) => c.getAttribute('aria-label'));
    expect(names).toEqual(['Agents', 'Signed in', 'Updates', 'Agents that agents start']);
    expect(card('agents').textContent).toContain('2 agents ready');
    expect(card('signed-in').textContent).toContain('Claude and Codex are signed in');
    expect(host.querySelector('[data-card="phone"]')).toBeNull();
    expect(card('updates').textContent).toContain('Up to date (1.0.19)');
    expect(card('helpers').textContent).toContain('Started agents open in a window and stay open');
    for (const id of ['agents', 'signed-in', 'updates', 'helpers']) expect(glyph(id)).toBe('✓');
  });

  it('the Signed in card lists every agent the Setup rows say is signed in, also one the accounts list does not name (Cursor)', async () => {
    await mount(
      fakeOverviewSources({
        checks: async () => [
          { id: 'agent-claude', status: 'ok', sentence: 'Claude is signed in', fix: null },
          { id: 'agent-codex', status: 'ok', sentence: 'Codex is signed in', fix: null },
          { id: 'agent-cursor_agent', status: 'ok', sentence: 'Cursor is signed in', fix: null },
        ],
      }),
    );
    expect(card('signed-in').textContent).toMatch(/Claude, Codex and Cursor/);
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
        update: async () => {
          throw new Error('no internet');
        },
        helpers: async () => {
          throw new Error('boom');
        },
      }),
    );
    for (const id of ['agents', 'signed-in', 'updates', 'helpers']) {
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
    const slow = new Promise<Awaited<ReturnType<ReturnType<typeof fakeOverviewSources>['helpers']>>>((r) => (release = () => r({ mode: 'always_show', keepOpen: true, connected: true })));
    await mount(fakeOverviewSources({ helpers: () => slow }));
    expect(card('helpers').textContent).toContain('Checking');
    expect(glyph('helpers')).toBe('…');
    expect(card('agents').textContent).toContain('2 agents ready');
    expect(card('updates').textContent).toContain('Up to date');
    await act(async () => release());
    await settle(3);
    expect(card('helpers').textContent).toContain('Started agents open in a window and stay open');
  });

  it('a failed beta check shows its own line on the Updates card, never Up to date', async () => {
    await mount(fakeOverviewSources({ update: () => Promise.reject("CHECK_FAILED_BETA: Couldn't check for early versions. Try again later.") }));
    expect(card('updates').textContent).toContain("Couldn't check for early versions. Try again later.");
    expect(card('updates').textContent).not.toContain('Up to date');
    expect(glyph('updates')).toBe('…');
  });

  it('each card action lands on the row the spec names', async () => {
    await mount(fakeOverviewSources({ helpers: async () => ({ mode: 'always_show', keepOpen: true, connected: false }) }));
    await click(button('agents', 'Check my setup'));
    expect(openRow).toHaveBeenLastCalledWith('setup-check');
    await click(button('signed-in', 'Manage'));
    expect(openRow).toHaveBeenLastCalledWith('accounts');
    await click(button('updates', "What's new"));
    expect(openRow).toHaveBeenLastCalledWith('whats-new');
    // Not connected: the Helpers card offers Turn on, which opens the agent-pack row.
    await click(button('helpers', 'Turn on'));
    expect(openRow).toHaveBeenLastCalledWith('agent-pack');
  });

  it('Update and Change go where the spec says', async () => {
    await mount(fakeOverviewSources({ update: async () => ({ currentVersion: '1.0.19', version: '1.0.20', notes: null }) }));
    expect(card('updates').textContent).toContain('1.0.20 is ready');
    await click(button('updates', 'Update'));
    expect(openRow).toHaveBeenLastCalledWith('version');
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
