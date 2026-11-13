// @vitest-environment jsdom
// The companion page's "Speak up first" card: off by default, the switch turns it on and shows the budget.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPEAK_DEFAULTS, getSpeak, reloadSpeakForTests, setSpeak } from '../../../lib/companionSpeak';
import { setLanguagePref } from '../../../i18n';
import { useChinese, visibleEnglish } from '../../../i18n/test-utils';
import { setValue } from './test-helpers';
import { SpeakCard } from './SpeakCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  reloadSpeakForTests();
  setLanguagePref('en', false);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  act(() => void setSpeak(SPEAK_DEFAULTS));
  setLanguagePref('auto', false);
});

describe('SpeakCard', () => {
  it('is off by default and has no budget until it is on', () => {
    act(() => root.render(<SpeakCard />));
    const sw = host.querySelector<HTMLInputElement>('input[role="switch"]')!;
    expect(sw.checked).toBe(false);
    expect(host.querySelector('select')).toBeNull();
    expect(host.textContent).toContain('Speak up first');
  });

  it('the switch turns it on, the budget changes, and the choice is saved', () => {
    act(() => root.render(<SpeakCard />));
    act(() => host.querySelector<HTMLInputElement>('input[role="switch"]')!.click());
    expect(getSpeak()).toMatchObject({ on: true, perHour: 3, offered: true });
    const select = host.querySelector<HTMLSelectElement>('select')!;
    expect(select.value).toBe('3');
    setValue(select, '6');
    expect(getSpeak().perHour).toBe(6);
    expect(JSON.parse(localStorage.getItem('pm.companion.speak')!).perHour).toBe(6);
  });

  it('reads in Chinese with no English left over', () => {
    useChinese();
    act(() => void setSpeak({ on: true }));
    act(() => root.render(<SpeakCard />));
    expect(host.textContent).toContain('主動出聲');
    expect(visibleEnglish(host)).toEqual([]);
  });
});
