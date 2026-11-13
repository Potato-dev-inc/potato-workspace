// Comfort prefs: the allowed text sizes, the step buttons, saved values that are read back safely, and reduced motion.
import { describe, expect, it } from 'vitest';
import { COMFORT_DEFAULTS, clampTextScale, parseComfort, reducedMotion, scaleFactor, stepTextScale } from './model';

describe('text size', () => {
  it('snaps any number to the nearest step from 90 to 140, and anything else to 100', () => {
    expect(clampTextScale(137)).toBe(140);
    expect(clampTextScale(50)).toBe(90);
    expect(clampTextScale(999)).toBe(140);
    expect(clampTextScale('120')).toBe(120);
    expect(clampTextScale('big')).toBe(100);
    expect(clampTextScale(undefined)).toBe(100);
  });

  it('one step bigger or smaller, stopping at both ends, and 0 goes back to 100', () => {
    expect(stepTextScale(100, 1)).toBe(110);
    expect(stepTextScale(100, -1)).toBe(90);
    expect(stepTextScale(140, 1)).toBe(140);
    expect(stepTextScale(90, -1)).toBe(90);
    expect(stepTextScale(130, 0)).toBe(100);
  });

  it('turns the size into the factor the page uses', () => {
    expect(scaleFactor({ ...COMFORT_DEFAULTS, textScale: 120 })).toBeCloseTo(1.2);
    expect(scaleFactor(COMFORT_DEFAULTS)).toBe(1);
  });
});

describe('saved prefs', () => {
  it('garbage or nothing saved gives the defaults: 100%, everything off', () => {
    expect(parseComfort(null)).toEqual(COMFORT_DEFAULTS);
    expect(parseComfort('nope')).toEqual(COMFORT_DEFAULTS);
    expect(parseComfort({ textScale: 'x', strongContrast: 'yes', lessMotion: 1, speakResults: {} })).toEqual(COMFORT_DEFAULTS);
  });

  it('a good saved value is read back', () => {
    expect(parseComfort({ textScale: 120, strongContrast: true, lessMotion: true, speakResults: true })).toEqual({
      textScale: 120,
      strongContrast: true,
      lessMotion: true,
      speakResults: true,
    });
  });

  it('speaking results is off by default', () => {
    expect(COMFORT_DEFAULTS.speakResults).toBe(false);
  });
});

describe('less motion', () => {
  it('is on when the person picks it, or when the system asks for reduced motion', () => {
    expect(reducedMotion(COMFORT_DEFAULTS, false)).toBe(false);
    expect(reducedMotion(COMFORT_DEFAULTS, true)).toBe(true);
    expect(reducedMotion({ ...COMFORT_DEFAULTS, lessMotion: true }, false)).toBe(true);
  });
});
