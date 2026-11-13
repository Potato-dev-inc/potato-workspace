// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { companionMood, isAsleepHour, isSleepyHour, type MoodInput } from './companionMood';

const base: MoodInput = { state: 'idle', waiting: 0, working: 0, agents: 0, notes: 0, justFinished: false, hour: 14 };
const mood = (over: Partial<MoodInput>) => companionMood({ ...base, ...over });

describe('companionMood', () => {
  it('is calm when nothing happens', () => {
    expect(mood({})).toMatchObject({ face: 'idle', key: 'companion.mood.here', urgent: false });
  });
  it('watches the agents, busy or not', () => {
    expect(mood({ agents: 3 })).toMatchObject({ face: 'idle', key: 'companion.mood.watching', vars: { count: 3 } });
    expect(mood({ agents: 3, working: 1 })).toMatchObject({ face: 'working', key: 'companion.mood.watching' });
  });
  it('needs-you beats everything, and names a single agent', () => {
    expect(mood({ waiting: 1, waitingName: 'Codex', working: 2, justFinished: true, hour: 2 })).toMatchObject({ face: 'needs-you', key: 'companion.mood.oneNeedsYou', vars: { name: 'Codex' }, urgent: true });
    expect(mood({ waiting: 2 })).toMatchObject({ key: 'companion.mood.manyNeedYou', vars: { count: 2 } });
    expect(mood({ state: 'needs_you' })).toMatchObject({ face: 'needs-you', key: 'companion.mood.needsYou' });
  });
  it('celebrates a run that just finished', () => {
    expect(mood({ justFinished: true, agents: 2 }).face).toBe('celebrate');
  });
  it('gets sleepy in the evening and sleeps at night, with notes', () => {
    expect(mood({ hour: 21 })).toMatchObject({ face: 'sleepy', key: 'companion.mood.sleepy' });
    expect(mood({ hour: 2, notes: 2 })).toMatchObject({ face: 'sleep', key: 'companion.mood.sleepyNotes', vars: { count: 2 } });
    expect(mood({ hour: 2, working: 1, agents: 1 }).face).toBe('working');
  });
  it('knows its own stopped and starting states', () => {
    expect(mood({ state: 'stopped' }).face).toBe('sleep');
    expect(mood({ state: 'starting' }).face).toBe('wave-hello');
  });
  it('knows which hours are sleepy and which are asleep', () => {
    const hours = [6, 7, 20, 21, 23, 0, 4, 5];
    expect(hours.map((h) => [isSleepyHour(h), isAsleepHour(h)])).toEqual([
      [true, false],
      [false, false],
      [false, false],
      [true, false],
      [true, true],
      [true, true],
      [true, true],
      [true, false],
    ]);
  });
});
