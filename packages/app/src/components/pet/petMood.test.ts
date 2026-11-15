import { describe, expect, it } from 'vitest';
import { newPet, petReduce, petView, SLEEPY_AFTER_MS } from './petModel';
import { petMoodId, petMoodLook } from './petMood';

const body = (mood: 'sleepy' | 'hungry' | 'genki' | 'tsundere', intensity: 1 | 2 | 3 = 1, sleeping = false) => ({ mood, intensity, sleeping });

describe('the pet\'s mood face', () => {
  it('maps the four saved moods to Potato poses', () => {
    expect(petMoodLook(body('sleepy', 1))).toMatchObject({ sprite: 'sleepy', play: 'still', resting: true });
    expect(petMoodLook(body('sleepy', 3))).toMatchObject({ sprite: 'sleep' });
    expect(petMoodLook(body('sleepy', 1, true))).toMatchObject({ sprite: 'sleep' });
    expect(petMoodLook(body('genki', 1))).toMatchObject({ sprite: 'idle', play: 'loop' });
    expect(petMoodLook(body('genki', 3))).toMatchObject({ sprite: 'celebrate', play: 'loop' });
    expect(petMoodLook(body('hungry'))).toMatchObject({ sprite: 'idle', play: 'still', key: 'companion.mood.hungry' });
    expect(petMoodLook(body('tsundere'))).toMatchObject({ sprite: 'idle', key: 'companion.mood.tsundere' });
  });

  it('no body state means no mood', () => {
    expect(petMoodLook(null)).toBeNull();
    expect(petMoodLook(undefined)).toBeNull();
    expect(petMoodId(null)).toBe('');
  });

  it('shows in the resting pet, never wakes it, and Less motion makes it one still frame', () => {
    const look = petMoodLook(body('genki', 3));
    const m = petReduce(newPet(0), { type: 'mood', mood: look }, 500);
    expect(m.lastActive).toBe(0);
    expect(petView(m, 1_000)).toMatchObject({ sprite: 'celebrate', play: 'loop' });
    expect(petView(m, 1_000, true)).toMatchObject({ sprite: 'celebrate', play: 'still' });
    // Long idle still wins: it gets sleepy whatever the mood.
    expect(petView(m, SLEEPY_AFTER_MS).sprite).toBe('sleepy');
  });

  it('a waiting agent and a drag come before the mood', () => {
    let m = petReduce(newPet(0), { type: 'mood', mood: petMoodLook(body('sleepy', 3)) }, 0);
    m = petReduce(m, { type: 'needs', needs: [{ key: 'a', paneId: 'p', agent: 'Claude' }] }, 100);
    expect(petView(m, 200).sprite).toBe('wave-hello');
    m = petReduce(newPet(0), { type: 'mood', mood: petMoodLook(body('sleepy', 3)) }, 0);
    expect(petView(petReduce(m, { type: 'dragStart' }, 10), 20).sprite).toBe('dragged');
  });
});
