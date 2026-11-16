// @vitest-environment jsdom
// Settings > Agents > Limits: the budget of this project (turns, minutes and a share of the plan a day) and the switch
// for the "try a model that fits" line. Both are in the Limits group of the Agents page and come in two languages.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref, t } from '../../../i18n';
import { SECTIONS } from '../catalog';
import { blur, click, mountRows, pickOption, settle, type as typeInto, type Mounted } from '../test-utils';
import { projectBudgetRows } from './ProjectBudgetRows';

const mocks = vi.hoisted(() => ({
  limits: { turnsPerDay: null as number | null, minutesPerDay: null as number | null, planPercent: null as number | null },
  saved: [] as unknown[],
}));

vi.mock('../../../lib/tauri', () => ({
  tauri: {
    projectBudgetLimits: vi.fn(async () => mocks.limits),
    projectBudgetSet: vi.fn(async (project: string, limits: unknown) => {
      mocks.saved.push([project, limits]);
      return limits;
    }),
  },
}));

let m: Mounted;
const input = (label: RegExp) => [...m.host.querySelectorAll<HTMLInputElement>('input')].find((i) => label.test(i.getAttribute('aria-label') ?? ''))!;

beforeEach(() => {
  setLanguagePref('en', false);
  mocks.limits = { turnsPerDay: null, minutesPerDay: null, planPercent: null };
  mocks.saved = [];
});
afterEach(async () => {
  await m?.unmount();
});

describe('Budget for this project', () => {
  it('has no limits at first and asks for a project when none is open', async () => {
    m = await mountRows(projectBudgetRows.filter((r) => r.id === 'project-budget'), { projectPath: null });
    expect(m.host.textContent).toContain('Open a project to set its budget.');
    expect(m.host.querySelectorAll('input').length).toBe(0);
  });

  it('shows the three limits for the open project, all 0 (no limit)', async () => {
    m = await mountRows(projectBudgetRows.filter((r) => r.id === 'project-budget'), { projectPath: 'C:\\work\\demo' });
    await settle();
    expect(m.host.textContent).toContain('For demo');
    expect((m.host.querySelector('select') as HTMLSelectElement).value).toBe('none');
    await pickOption(m.host.querySelector('select') as HTMLSelectElement, 'custom');
    const values = [/Turns a day/, /Agent minutes a day/, /Share of the plan/].map((label) => input(label).value);
    expect(values).toEqual(['0', '0', '0']);
  });

  it('saves each limit for this project only, and 0 turns it off again', async () => {
    m = await mountRows(projectBudgetRows.filter((r) => r.id === 'project-budget'), { projectPath: 'C:\\work\\demo' });
    await settle();
    await pickOption(m.host.querySelector('select') as HTMLSelectElement, 'custom');
    const turns = input(/Turns a day/);
    await typeInto(turns, '12');
    await blur(turns);
    const plan = input(/Share of the plan/);
    await typeInto(plan, '900');
    await blur(plan);
    expect(mocks.saved).toEqual([
      ['C:\\work\\demo', { turnsPerDay: 12, minutesPerDay: null, planPercent: null }],
      ['C:\\work\\demo', { turnsPerDay: 12, minutesPerDay: null, planPercent: 100 }],
    ]);
    await typeInto(turns, '0');
    await blur(turns);
    expect(mocks.saved[2]).toEqual(['C:\\work\\demo', { turnsPerDay: null, minutesPerDay: null, planPercent: 100 }]);
  });
});

describe('Suggest a model that fits', () => {
  it('is on by default and saves only {right_size_suggest}', async () => {
    m = await mountRows(projectBudgetRows.filter((r) => r.id === 'right-size'));
    const toggle = m.host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await click(toggle);
    expect(m.env.patches).toEqual([{ right_size_suggest: false }]);
  });
});

describe('where the rows live', () => {
  it('both rows sit in the Limits group of the Agents page', () => {
    const agents = SECTIONS.find((s) => s.id === 'agents');
    const ids = (agents?.rows ?? []).filter((r) => r.group === 'Limits').map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['project-budget', 'right-size']));
  });

  it('has Traditional Chinese words for every new string', () => {
    setLanguagePref('zh-TW', false);
    for (const key of ['settings.row.project-budget.label', 'settings.row.project-budget.hint', 'settings.row.right-size.label', 'settings.row.right-size.hint', 'projectBudget.title', 'rightSize.switch', 'speed.copy'] as const) {
      expect(t(key), key).not.toBe(key);
      expect(t(key), key).not.toMatch(/^[\x20-\x7e]+$/);
    }
    setLanguagePref('en', false);
  });
});
