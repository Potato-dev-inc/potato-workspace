// @vitest-environment jsdom
// Request usage through the real Team page (Usage tab) inside the cockpit's own layers. The founder's bug: the sheet showed but
// nothing on it took a click, because it was drawn inside the see-through join-popup layer (`.settings.jl-host`, pointer-events
// none). jsdom has no layout, so the proof here is where the sheet is drawn, which layer is above it, and that every control
// does its job when used; the real hit-test (elementFromPoint) runs in the headless browser proof (see the evidence folder).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeLendApi, GRANT_IN, GRANT_OUT, LEND_MEMBERS, REQUEST_MAYA } from '../../dev/lend-fixtures';
import { teamConfig, teamState } from '../../dev/team-fixtures';
import type { TeamApi } from '../../lib/team';
import { click, settle, type } from '../settings/test-utils';
import { resetRememberedTab } from './TeamPage';
import { TeamHost } from './TeamHost';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
const openSettingsAt = vi.fn();
vi.mock('../../lib/openSettingsAt', () => ({ openSettingsAt: (...a: unknown[]) => openSettingsAt(...a) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = () => {};

let cockpit: HTMLDivElement;
let joinLayer: HTMLDivElement;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  resetRememberedTab();
  openSettingsAt.mockClear();
  // The cockpit as the app builds it: the page, and next to it the join popup's see-through layer.
  cockpit = document.createElement('div');
  cockpit.className = 'cockpit';
  host = document.createElement('div');
  joinLayer = document.createElement('div');
  joinLayer.className = 'settings jl-host';
  joinLayer.style.pointerEvents = 'none';
  cockpit.append(host, joinLayer);
  document.body.appendChild(cockpit);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  cockpit.remove();
  document.body.innerHTML = '';
});

const team = () =>
  ({
    state: async () => teamState({ presence: [] }),
    configGet: async () => teamConfig({ members: LEND_MEMBERS }),
    defaultName: async () => 'Leo',
    onChanged: async () => () => {},
    onDraft: async () => () => {},
  }) as unknown as TeamApi;

async function openSheet() {
  const lend = createFakeLendApi({ grants: [GRANT_OUT, GRANT_IN], requests_in: [REQUEST_MAYA] });
  await act(async () => root.render(<TeamHost api={team()} lendClient={lend} />));
  await settle(6);
  await click(host.querySelector('[data-testid="tab-usage"]'));
  await settle(4);
  await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Request usage'));
  await settle(6);
  return lend;
}

describe('Team page > Usage > Request usage takes clicks', () => {
  it('draws the sheet in the cockpit, never inside the join popup layer, and the scrim takes the mouse itself', async () => {
    await openSheet();
    const sheet = document.querySelector<HTMLElement>('.lend-sheet')!;
    expect(sheet).toBeTruthy();
    expect(sheet.closest('.jl-host')).toBeNull();
    expect(sheet.closest('.cockpit')).toBe(cockpit);
    expect(joinLayer.children).toHaveLength(0);
    // No ancestor of the sheet ignores the mouse.
    for (let el: HTMLElement | null = sheet; el; el = el.parentElement) expect(el.style.pointerEvents, el.className).not.toBe('none');
  });

  it('change who to ask, pick 1 hour, type a reason, press Ask: the request call is made with exactly those', async () => {
    const lend = await openSheet();
    const sheet = () => document.querySelector<HTMLElement>('.lend-sheet')!;
    const who = sheet().querySelector<HTMLSelectElement>('select[aria-label="Ask"]')!;
    const options = [...who.querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toContain('Maya');
    await act(async () => {
      who.value = [...who.querySelectorAll('option')].find((o) => o.textContent === 'Maya')!.value;
      who.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle(6);
    await click([...sheet().querySelectorAll('button')].find((b) => b.textContent === '1 hour'));
    expect([...sheet().querySelectorAll('button')].find((b) => b.textContent === '1 hour')!.getAttribute('aria-pressed')).toBe('true');
    await type(sheet().querySelector<HTMLTextAreaElement>('textarea')!, 'Need Claude for a build');
    const ask = [...sheet().querySelectorAll('button')].find((b) => b.textContent === 'Ask') as HTMLButtonElement;
    expect(ask.disabled).toBe(false);
    await click(ask);
    await settle(4);
    const made = lend.calls.filter((c) => c.startsWith('request('));
    expect(made).toHaveLength(1);
    expect(made[0]).toContain('m-maya');
    expect(made[0]).toContain('3600');
    expect(made[0]).toContain('Need Claude for a build');
  });

  it('Cancel closes the sheet', async () => {
    await openSheet();
    await click([...document.querySelectorAll('.lend-sheet button')].find((b) => b.textContent === 'Cancel'));
    expect(document.querySelector('.lend-sheet')).toBeNull();
  });
});
