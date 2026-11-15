// Desktop Potato: the default companion's saved mood as a Potato pose. Pure. It uses the same four moods and the same
// words as the sidebar row (lib/companionMood.ts), drawn with the pet's own sprite sheets (the Potato animation pack).
// Only moods the companion really has: with no body state (the Labs switch is off) there is no mood and nothing changes.
import type { BodyView } from '../../lib/companion';
import type { MessageKey } from '../../i18n';
import type { PetPlay, SpriteName } from './petModel';

export interface PetMoodLook {
  sprite: SpriteName;
  /** `still` is a held frame; `loop` is the lively pose. Less motion makes every one still. */
  play: PetPlay;
  /** The same plain words the sidebar row shows ("Sleepy", "Hungry"). */
  key: MessageKey;
  /** The pose is a resting one (sleepy or asleep). */
  resting: boolean;
}

type BodyLike = Pick<BodyView, 'mood' | 'intensity' | 'sleeping'>;

export function petMoodLook(body: BodyLike | null | undefined): PetMoodLook | null {
  if (!body) return null;
  switch (body.mood) {
    case 'sleepy':
      return body.sleeping || body.intensity >= 3
        ? { sprite: 'sleep', play: 'still', key: 'companion.mood.sleepy', resting: true }
        : { sprite: 'sleepy', play: 'still', key: 'companion.mood.sleepy', resting: true };
    case 'genki':
      return body.intensity >= 3
        ? { sprite: 'celebrate', play: 'loop', key: 'companion.mood.genki', resting: false }
        : { sprite: 'idle', play: 'loop', key: 'companion.mood.genki', resting: false };
    case 'hungry':
      return { sprite: 'idle', play: 'still', key: 'companion.mood.hungry', resting: false };
    case 'tsundere':
      return { sprite: 'idle', play: 'still', key: 'companion.mood.tsundere', resting: false };
    default:
      return null;
  }
}

/** A short key so a new look is dispatched only when the pose really changes. */
export const petMoodId = (look: PetMoodLook | null): string => (look ? `${look.sprite}|${look.play}|${look.key}` : '');
