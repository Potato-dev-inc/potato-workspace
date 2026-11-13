// @vitest-environment jsdom
// The Getting started card: "N of 6", each row ticks itself, each open row has one button, Hide removes it, and when
// all six are done the Potato celebrates once and the card never comes back.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GETTING_STARTED_EVENT, getState, markStep, resetGettingStarted, seedSteps, STEP_IDS } from '../../../lib/getting-started';
import { registerSettingsOpener } from '../../../lib/openSettingsAt';
import { CELEBRATE_MS, GettingStarted } from './GettingStarted';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  resetGettingStarted();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  registerSettingsOpener(null);
  vi.useRealTimers();
});

const card = () => host.querySelector<HTMLElement>('[data-testid="getting-started"]');
const row = (step: string) => host.querySelector<HTMLElement>(`[data-step="${step}"]`)!;
const render = (props: Partial<React.ComponentProps<typeof GettingStarted>> = {}) => act(async () => root.render(<GettingStarted onStartAgent={vi.fn()} agentCount={1} {...props} />));

describe('the Getting started card', () => {
  it('stays away until the first look at what the person already did has happened', async () => {
    await render();
    expect(card()).toBeNull();
  });

  it('says "2 of 6" and ticks the rows that are done', async () => {
    seedSteps(['second', 'phone']);
    await render();
    expect(card()!.textContent).toContain('Getting started · 2 of 6');
    expect(row('second').dataset.done).toBe('true');
    expect(row('phone').dataset.done).toBe('true');
    expect(row('review').dataset.done).toBe('false');
    // A ticked row has no button; an open one has exactly one.
    expect(row('second').querySelector('button')).toBeNull();
    expect(row('review').querySelectorAll('button')).toHaveLength(1);
  });

  it('ticks a row by itself when the thing happens anywhere', async () => {
    seedSteps([]);
    await render();
    expect(card()!.textContent).toContain('0 of 6');
    await act(async () => markStep('undo'));
    expect(card()!.textContent).toContain('1 of 6');
    expect(row('undo').dataset.done).toBe('true');
  });

  it('every row has a name a person can read, and no row needs a terminal', async () => {
    seedSteps([]);
    await render();
    const text = card()!.textContent!;
    for (const word of ['Start a second agent', 'Put two side by side', 'Review a change', 'Undo a turn', 'Pair your phone', 'Set a limit']) expect(text).toContain(word);
    expect(text.toLowerCase()).not.toContain('terminal');
  });

  it('the buttons do the thing: start one focuses the box, review and undo ask the cockpit, phone and limit open Settings', async () => {
    seedSteps([]);
    const onStartAgent = vi.fn();
    const asked: string[] = [];
    const listener = (e: Event) => asked.push((e as CustomEvent<{ action: string }>).detail.action);
    window.addEventListener(GETTING_STARTED_EVENT, listener);
    const opened: string[] = [];
    registerSettingsOpener((tab) => opened.push(tab));
    await render({ onStartAgent, agentCount: 3 });
    const press = (step: string) => act(async () => row(step).querySelector('button')!.click());
    await press('second');
    await press('side');
    await press('review');
    await press('undo');
    await press('phone');
    await press('limit');
    window.removeEventListener(GETTING_STARTED_EVENT, listener);
    expect(onStartAgent).toHaveBeenCalledTimes(1);
    expect(asked).toEqual(['side', 'review', 'undo']);
    expect(opened).toEqual(['phone', 'budget-turns']);
  });

  it('two side by side with one agent says what to do first and asks for nothing', async () => {
    seedSteps([]);
    const asked: string[] = [];
    const listener = (e: Event) => asked.push((e as CustomEvent<{ action: string }>).detail.action);
    window.addEventListener(GETTING_STARTED_EVENT, listener);
    await render({ agentCount: 1 });
    await act(async () => row('side').querySelector('button')!.click());
    window.removeEventListener(GETTING_STARTED_EVENT, listener);
    expect(asked).toEqual([]);
    expect(card()!.textContent).toContain('Start a second agent first');
  });

  it('Hide removes the card and it stays hidden', async () => {
    seedSteps(['second']);
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('.ck-na-gs-hide')!.click());
    expect(card()).toBeNull();
    expect(getState().hidden).toBe(true);
  });

  it('when all six are done the Potato celebrates once, then the card is gone for good', async () => {
    vi.useFakeTimers();
    seedSteps(STEP_IDS.slice(0, 5));
    await render();
    expect(row('limit').dataset.done).toBe('false');
    await act(async () => markStep('limit'));
    expect(card()!.className).toContain('ck-na-gs--done');
    expect(card()!.querySelector('img[data-mark="potato"], picture, svg, img')).not.toBeNull();
    expect(card()!.textContent).toContain('That is all of them');
    await act(async () => void vi.advanceTimersByTime(CELEBRATE_MS + 50));
    expect(card()).toBeNull();
    expect(getState().celebrated).toBe(true);
    // Mounted again later (a new window, a restart): it does not come back.
    await act(async () => root.render(<div />));
    await render();
    expect(card()).toBeNull();
  });

  it('a person who had done everything before sees no card and no celebration', async () => {
    seedSteps([...STEP_IDS]);
    await render();
    expect(card()).toBeNull();
  });
});
