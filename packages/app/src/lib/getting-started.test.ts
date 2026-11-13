// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { getState, GETTING_STARTED_KEY, hideGettingStarted, markCelebrated, markStep, parseState, resetGettingStarted, seedSteps, STEP_IDS, viewOf } from './getting-started';

beforeEach(() => {
  localStorage.clear();
  resetGettingStarted();
});

describe('the Getting started list', () => {
  it('has the six steps, none of them about terminals', () => {
    expect(STEP_IDS).toEqual(['second', 'side', 'review', 'undo', 'phone', 'limit']);
  });

  it('a step ticks once, in list order, and is saved', () => {
    markStep('review');
    markStep('second');
    markStep('review');
    expect(getState().done).toEqual(['second', 'review']);
    expect(JSON.parse(localStorage.getItem(GETTING_STARTED_KEY)!).done).toEqual(['second', 'review']);
    expect(viewOf(getState()).doneCount).toBe(2);
  });

  it('what the person already did is ticked on the first look, and only on the first', () => {
    seedSteps(['second', 'phone']);
    expect(getState()).toMatchObject({ done: ['second', 'phone'], seeded: true, celebrated: false });
    seedSteps(['limit']);
    expect(getState().done).toEqual(['second', 'phone']);
  });

  it('a person who already did all six never sees the card or a celebration', () => {
    seedSteps([...STEP_IDS]);
    expect(getState().celebrated).toBe(true);
  });

  it('Hide and the celebration are remembered', () => {
    hideGettingStarted();
    markCelebrated();
    resetGettingStartedMemoryOnly();
    expect(getState()).toMatchObject({ hidden: true, celebrated: true });
  });

  it('broken saved data reads as a fresh start, never a crash', () => {
    expect(parseState('{nope')).toMatchObject({ done: [], hidden: false });
    expect(parseState(JSON.stringify({ done: ['second', 'bogus', 7] })).done).toEqual(['second']);
    expect(parseState(null).seeded).toBe(false);
  });
});

/** Forget the in-memory copy only: the saved one must bring the state back. */
function resetGettingStartedMemoryOnly(): void {
  const saved = localStorage.getItem(GETTING_STARTED_KEY);
  resetGettingStarted();
  if (saved) localStorage.setItem(GETTING_STARTED_KEY, saved);
}
