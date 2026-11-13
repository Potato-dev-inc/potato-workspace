import { describe, expect, it } from 'vitest';
import {
  CELEBRATE_MS,
  LATER_MS,
  NEEDS_ANIM_MS,
  NUDGE_MS,
  SLEEPY_AFTER_MS,
  SLEEP_AFTER_MS,
  SPRITE_FRAMES,
  WAVE_MS,
  canWalk,
  newPet,
  nextDeadline,
  petReduce,
  petView,
  type PetEvent,
  type PetModel,
  type PetNeed,
} from './petModel';

const need = (key: string, agent = 'Claude'): PetNeed => ({ key, paneId: `pane-${key}`, agent });
const run = (m: PetModel, at: number, ...events: PetEvent[]) => events.reduce((cur, e) => petReduce(cur, e, at), m);

describe('Desktop Potato rules', () => {
  it('rests awake, then sleepy, then asleep when nothing happens', () => {
    const m = newPet(0);
    expect(petView(m, 1_000).sprite).toBe('idle');
    expect(petView(m, SLEEPY_AFTER_MS).sprite).toBe('sleepy');
    expect(petView(m, SLEEP_AFTER_MS).sprite).toBe('sleep');
    // A still picture all the way: nothing animates while it rests.
    for (const t of [1_000, SLEEPY_AFTER_MS, SLEEP_AFTER_MS]) expect(petView(m, t).play).toBe('still');
  });

  it('an agent that needs the person: it waves once, then the needs-you loop, then rests on one frame', () => {
    const m = run(newPet(0), 10_000, { type: 'needs', needs: [need('a')] });
    expect(petView(m, 10_000).sprite).toBe('wave-hello');
    expect(petView(m, 10_000).play).toBe('once');
    expect(petView(m, 10_000 + WAVE_MS).sprite).toBe('needs-you');
    expect(petView(m, 10_000 + WAVE_MS).play).toBe('loop');
    expect(petView(m, 10_000 + WAVE_MS + NEEDS_ANIM_MS).sprite).toBe('needs-you');
    expect(petView(m, 10_000 + WAVE_MS + NEEDS_ANIM_MS).play).toBe('still');
    expect(petView(m, 10_000).needsCount).toBe(1);
  });

  it('the bubble says who needs the person and goes when they are answered', () => {
    let m = run(newPet(0), 100, { type: 'needs', needs: [need('a', 'Codex')] });
    expect(petView(m, 100).bubble).toMatchObject({ kind: 'needs', agent: 'Codex', paneId: 'pane-a' });
    m = run(m, 200, { type: 'needs', needs: [] });
    expect(petView(m, 200).bubble).toBeNull();
    expect(petView(m, 200).sprite).toBe('idle');
  });

  it('a long wait nudges: the loop plays again every so often', () => {
    const m = run(newPet(0), 0, { type: 'needs', needs: [need('a')] });
    const later = petView(m, NUDGE_MS + 1);
    expect(later.sprite).toBe('needs-you');
    expect(later.play).toBe('loop');
    expect(nextDeadline(m, WAVE_MS + NEEDS_ANIM_MS + 1)).toBe(NUDGE_MS);
    // The tick keeps the nudge in the model, so the next one is a full period later.
    expect(petReduce(m, { type: 'tick' }, NUDGE_MS + 1).nudgeAt).toBe(NUDGE_MS + 1 + NUDGE_MS);
  });

  it('a second agent that needs the person waves again; the same one does not', () => {
    let m = run(newPet(0), 0, { type: 'needs', needs: [need('a')] });
    const settled = 60_000;
    m = run(m, settled, { type: 'needs', needs: [need('a')] });
    expect(petView(m, settled + 10).sprite).toBe('needs-you');
    m = run(m, settled + 100, { type: 'needs', needs: [need('a'), need('b', 'Gemini')] });
    expect(petView(m, settled + 100).sprite).toBe('wave-hello');
    expect(petView(m, settled + 100).needsCount).toBe(2);
  });

  it('Later hides the bubble for a while but the Potato keeps asking with its body', () => {
    let m = run(newPet(0), 0, { type: 'needs', needs: [need('a')] });
    m = run(m, 5_000, { type: 'later' });
    expect(petView(m, 5_001).bubble).toBeNull();
    expect(petView(m, 5_001).sprite).toBe('needs-you');
    expect(petView(m, 5_000 + LATER_MS + 1).bubble).toMatchObject({ kind: 'needs' });
    expect(nextDeadline(m, 6_000)).toBeLessThanOrEqual(5_000 + LATER_MS);
  });

  it('a finished run: it celebrates a moment and says so, then goes back to rest', () => {
    const m = run(newPet(0), 1_000, { type: 'finished', agent: 'Claude', paneId: 'p1' });
    expect(petView(m, 1_000).sprite).toBe('celebrate');
    expect(petView(m, 1_000).bubble).toMatchObject({ kind: 'done', agent: 'Claude', paneId: 'p1' });
    const after = petView(m, 1_000 + CELEBRATE_MS + 3_000);
    expect(after.sprite).toBe('idle');
    expect(after.bubble).toBeNull();
  });

  it('an agent that needs the person wins over a celebration that has ended, and a celebration over rest', () => {
    let m = run(newPet(0), 0, { type: 'needs', needs: [need('a')] });
    m = run(m, 70_000, { type: 'finished', agent: 'Codex' });
    expect(petView(m, 70_000).sprite).toBe('celebrate');
    expect(petView(m, 70_000 + CELEBRATE_MS).sprite).toBe('needs-you');
  });

  it('quiet: asleep and silent, no wave, no bubble, no celebration, but the count is still there', () => {
    let m = run(newPet(0), 0, { type: 'quiet', on: true });
    m = run(m, 10, { type: 'needs', needs: [need('a')] }, { type: 'finished', agent: 'Claude' }, { type: 'say', text: 'hi' });
    const view = petView(m, 20);
    expect(view.sprite).toBe('sleep');
    expect(view.play).toBe('still');
    expect(view.bubble).toBeNull();
    expect(view.needsCount).toBe(1);
    // Waking up shows what is still waiting.
    m = run(m, 30, { type: 'quiet', on: false });
    expect(petView(m, 30).bubble).toMatchObject({ kind: 'needs' });
    expect(petView(m, 30).sprite).toBe('needs-you');
  });

  it('Less motion draws every state as one still frame', () => {
    const waving = run(newPet(0), 0, { type: 'needs', needs: [need('a')] });
    expect(petView(waving, 0, true)).toMatchObject({ sprite: 'wave-hello', play: 'still' });
    const happy = run(newPet(0), 0, { type: 'finished', agent: 'Claude' });
    expect(petView(happy, 0, true)).toMatchObject({ sprite: 'celebrate', play: 'still' });
    const dragged = run(newPet(0), 0, { type: 'dragStart' });
    expect(petView(dragged, 0, true).play).toBe('still');
  });

  it('a drag shows the dragged frames, then it lands, then it rests', () => {
    let m = run(newPet(0), 0, { type: 'dragStart' });
    expect(petView(m, 1).sprite).toBe('dragged');
    m = run(m, 2_000, { type: 'dragEnd' });
    expect(petView(m, 2_000).sprite).toBe('land');
    expect(petView(m, 2_000).play).toBe('once');
    expect(petView(m, 2_000 + 800).sprite).toBe('idle');
  });

  it('walks only when awake, calm and not held; a drag or news stops a walk', () => {
    const calm = newPet(0);
    expect(canWalk(calm, 1_000)).toBe(true);
    expect(canWalk(petReduce(calm, { type: 'quiet', on: true }, 5), 1_000)).toBe(false);
    expect(canWalk(calm, SLEEPY_AFTER_MS)).toBe(false);
    expect(canWalk(run(calm, 1, { type: 'needs', needs: [need('a')] }), 1_000)).toBe(false);
    expect(canWalk(run(calm, 1, { type: 'dragStart' }), 1_000)).toBe(false);
    let m = run(calm, 1_000, { type: 'walkStart', dir: 'left', ms: 2_500 });
    expect(petView(m, 1_100).sprite).toBe('walk-left');
    expect(petView(m, 1_100).play).toBe('loop');
    m = run(m, 1_200, { type: 'needs', needs: [need('a')] });
    expect(m.walk).toBeNull();
    // A start request that is not allowed is ignored.
    expect(run(m, 1_300, { type: 'walkStart', dir: 'right', ms: 2_000 }).walk).toBeNull();
    // It ends by itself.
    const walking = run(calm, 1_000, { type: 'walkStart', dir: 'right', ms: 2_500 });
    expect(petView(walking, 3_600).sprite).toBe('idle');
  });

  it('a spoken line shows the talking frames and a bubble, then goes', () => {
    const m = run(newPet(0), 0, { type: 'say', text: 'Morning!' });
    expect(petView(m, 10)).toMatchObject({ sprite: 'talk', bubble: { kind: 'say', text: 'Morning!' } });
    expect(petView(m, 10_000).bubble).toBeNull();
  });

  it('nothing is scheduled for a pet that sleeps in quiet: no timer wakes it', () => {
    const m = run(newPet(0), 0, { type: 'quiet', on: true });
    expect(nextDeadline(m, 1)).toBeNull();
  });

  it('every state the pet can pick has frames', () => {
    for (const name of Object.keys(SPRITE_FRAMES)) expect(SPRITE_FRAMES[name as keyof typeof SPRITE_FRAMES]).toBeGreaterThan(0);
  });
});
