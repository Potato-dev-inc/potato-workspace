// @vitest-environment jsdom
// The small pure parts of the phone setup steps: the count behind the home's one chip, and the remembered test.
import { beforeEach, describe, expect, it } from 'vitest';
import { markTestSent, SETUP_STEPS, setupDoneCount, testSent } from './phone-setup';

describe('phone setup progress', () => {
  beforeEach(() => localStorage.clear());

  it('counts the three steps and remembers a test notification that was seen', () => {
    expect(SETUP_STEPS).toBe(3);
    expect(setupDoneCount({ home: false, notifications: false, test: false })).toBe(0);
    expect(setupDoneCount({ home: true, notifications: false, test: true })).toBe(2);
    expect(setupDoneCount({ home: true, notifications: true, test: true })).toBe(3);
    expect(testSent()).toBe(false);
    markTestSent();
    expect(testSent()).toBe(true);
  });
});
