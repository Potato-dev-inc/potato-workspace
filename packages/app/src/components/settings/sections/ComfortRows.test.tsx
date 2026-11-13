// @vitest-environment jsdom
// Settings > Look and feel > Comfort: the four rows render, change the shared prefs at once, and never write
// to the settings file (they live on this computer).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMFORT_DEFAULTS, COMFORT_KEY } from '../../../lib/comfort/model';
import { getComfort, setComfort } from '../../../lib/comfort/store';
import { mountRows, pickOption, click, settle, type Mounted } from '../test-utils';
import { comfortRows } from './ComfortRows';

let m: Mounted;

const switchFor = (label: string) => m.host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`);

beforeEach(() => {
  setComfort(COMFORT_DEFAULTS);
  localStorage.removeItem(COMFORT_KEY);
});

afterEach(async () => {
  await m?.unmount();
  setComfort(COMFORT_DEFAULTS);
  localStorage.removeItem(COMFORT_KEY);
});

describe('Comfort rows', () => {
  it('shows the four rows with their plain hints', async () => {
    m = await mountRows(comfortRows);
    expect(m.host.textContent).toContain('Makes everything bigger or smaller. Ctrl + and Ctrl - change it too.');
    expect(m.host.textContent).toContain('Stops animations and spinners. Also on when Windows asks for less motion.');
    expect(m.host.textContent).toContain('When an agent finishes, the Windows voice says so. Nothing leaves this computer.');
    expect(switchFor('Strong contrast')!.getAttribute('aria-checked')).toBe('false');
    expect(switchFor('Less motion')!.getAttribute('aria-checked')).toBe('false');
    expect(switchFor('Say results out loud')!.getAttribute('aria-checked')).toBe('false');
  });

  it('text size offers 90% to 140% and a pick saves it for every screen', async () => {
    m = await mountRows(comfortRows);
    const select = m.host.querySelector<HTMLSelectElement>('select[aria-label="Text size"]')!;
    expect([...select.options].map((o) => o.textContent)).toEqual(['90%', '100%', '110%', '120%', '130%', '140%']);
    await pickOption(select, '130');
    await settle();
    expect(getComfort().textScale).toBe(130);
    expect(JSON.parse(localStorage.getItem(COMFORT_KEY)!).textScale).toBe(130);
    expect(m.env.patches).toEqual([]);
  });

  it('each switch changes its own pref and does not touch the settings file', async () => {
    m = await mountRows(comfortRows);
    await click(switchFor('Strong contrast'));
    expect(getComfort().strongContrast).toBe(true);
    expect(switchFor('Strong contrast')!.getAttribute('aria-checked')).toBe('true');
    await click(switchFor('Less motion'));
    expect(getComfort().lessMotion).toBe(true);
    await click(switchFor('Say results out loud'));
    expect(getComfort().speakResults).toBe(true);
    expect(m.env.patches).toEqual([]);
  });
});
