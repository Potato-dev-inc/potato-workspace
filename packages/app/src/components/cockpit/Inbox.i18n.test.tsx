// @vitest-environment jsdom
// The Inbox in Traditional Chinese: its own words (heading, chips, keys, empty state, ages) come from the catalog.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { PanePrompt } from '../../lib/cockpit-api';
import type { Question } from '../../lib/questions';
import { t } from '../../i18n';
import { useChinese, useEnglish, visibleEnglish } from '../../i18n/test-utils';
import { Inbox } from './Inbox';

const settings = vi.hoisted(() => ({ patchSettings: vi.fn(() => Promise.resolve({})) }));
vi.mock('../../lib/settings', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/settings')>()), patchSettings: settings.patchSettings }));

const collision = vi.hoisted(() => ({ list: vi.fn((): Promise<unknown[]> => Promise.resolve([])) }));
vi.mock('../../lib/collision', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/collision')>()),
  tauriCollisionApi: { list: collision.list, ignore: vi.fn(), settingsGet: vi.fn(), settingsSet: vi.fn(), onChanged: () => Promise.resolve(() => {}) },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useChinese();
  (Element.prototype as { scrollIntoView?: () => void }).scrollIntoView = () => {};
  window.localStorage.setItem('pm.cockpit.everSpawned', '1');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.localStorage.clear();
  useEnglish();
});

const NOW = 600_000;
const info = (id: string, agent: string, status: string, cwd: string): PaneInfo =>
  ({ id, agent_type: agent, pid: 1, status, created_at: 1, last_output_at: null, cwd, cols: 80, rows: 24, title: null }) as unknown as PaneInfo;

const prompt = (level: 'low' | 'high', headline: string): PanePrompt => ({
  promptId: `p-${level}`,
  kind: 'command_approval',
  text: 'raw',
  summary: 'Run command: x',
  choices: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No, tell Claude what to do differently' },
  ],
  risk: { level, headline, reasons: ['It does a thing.', 'It cannot be undone.'] },
});

const question = (over: Partial<Question> = {}): Question => ({
  id: 'q1',
  agent: 'Planner',
  question: 'Which database?',
  choices: [{ id: 'pg', label: 'Postgres' }, { id: 'sq', label: 'SQLite' }],
  allow_free_text: false,
  urgency: 'normal',
  created_at_ms: NOW - 240_000,
  expires_at_ms: NOW + 600_000,
  state: 'pending',
  ...over,
});

function fixture(over: { questions?: Question[]; panes?: { id: string; agent: string; status: string; cwd: string }[] } = {}) {
  const spec = over.panes ?? [
    { id: 'lo', agent: 'claude', status: 'waiting_input', cwd: 'C:\\work\\shop' },
    { id: 'ps', agent: 'powershell', status: 'error', cwd: 'C:\\work\\shop' },
  ];
  const list = spec.map((p) => ({ info: info(p.id, p.agent, p.status, p.cwd), status: p.status }));
  const since: Record<string, number> = { lo: NOW - 300_000, ps: NOW - 60_000 };
  const api = {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map([['lo', 'Claude'], ['ps', 'PowerShell']]),
    asked: { questions: over.questions ?? [], answerQuestion: vi.fn(), dismissQuestion: vi.fn() },
    launchEntries: [],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select: vi.fn(),
    prompts: { lo: prompt('low', 'Run tests') } as Record<string, PanePrompt>,
    statusSince: new Map(Object.entries(since)),
    now: NOW,
    spawn: null,
    answer: vi.fn(),
    interrupt: vi.fn(),
    newAgent: vi.fn(),
  } as unknown as CockpitApi;
  return { api };
}

const mount = (api: CockpitApi) => act(() => root.render(<Inbox c={api} />));
const cards = () => Array.from(host.querySelectorAll<HTMLElement>('[data-ib-card]'));

describe('the Inbox in Traditional Chinese', () => {
  it('shows the empty page in Chinese, with nothing left in English', () => {
    const { api } = fixture({ panes: [], questions: [] });
    mount(api);
    expect(host.textContent).toContain(t('inbox.title'));
    expect(host.textContent).toContain(t('inbox.nothingNeedsYou'));
    expect(host.querySelector('[data-empty-state]')).not.toBeNull();
    expect(visibleEnglish(host.querySelector('.ck-inbox')!, ['Potato', 'Workspace'])).toEqual([]);
  });

  it('shows the heading count, the kind chips and the ages in Chinese', () => {
    const { api } = fixture({ questions: [question()] });
    mount(api);
    expect(host.querySelector('h1')?.textContent).toContain(t('inbox.title'));
    expect(host.querySelector('ul[aria-label="' + t('inbox.needsYouList') + '"]')).not.toBeNull();
    expect(host.querySelector('[data-chip="question"]')?.textContent).toContain(t('inbox.chipQuestion'));
    expect(host.querySelector('[data-chip="stopped"]')?.textContent).toContain(t('inbox.chipStopped'));
    // the question is 4 minutes old
    expect(Array.from(host.querySelectorAll('.ib-age')).map((a) => a.textContent)).toContain(t('inbox.shortMinutes', { n: 4 }));
  });

  it('opens the key hints in Chinese', () => {
    const { api } = fixture({ questions: [question()] });
    mount(api);
    const keys = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === t('inbox.keys'))!;
    act(() => keys.click());
    const hint = host.querySelector('p.ib-hint')!;
    expect(hint.getAttribute('aria-label')).toBe(t('inbox.keyboardShortcuts'));
    expect(hint.textContent).toContain(t('inbox.move'));
    expect(hint.textContent).toContain(t('inbox.answer'));
    expect(hint.textContent).toContain(t('inbox.open'));
  });

  it('translates the error card buttons it owns', () => {
    const { api } = fixture({ questions: [] });
    mount(api);
    const errorCard = host.querySelector<HTMLElement>('[data-error-pane="ps"]');
    expect(errorCard).not.toBeNull();
    expect(Array.from(errorCard!.querySelectorAll('button')).map((b) => b.textContent)).toContain(t('inbox.open'));
    expect(errorCard!.textContent).toContain(t('inboxCards.stuck.askAnother'));
    expect(cards().length).toBeGreaterThan(0);
  });
});
