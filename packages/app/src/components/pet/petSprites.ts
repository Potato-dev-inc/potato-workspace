// The Potato sprite sheets: one image per state, frames side by side (160 px each, made from the pet pack in
// design/potato/exports/pet). Potato artwork (c) the Puppet Master founder.
import idle from '../../assets/potato/pet/idle.webp';
import blink from '../../assets/potato/pet/blink.webp';
import sleepy from '../../assets/potato/pet/sleepy.webp';
import sleep from '../../assets/potato/pet/sleep.webp';
import waveHello from '../../assets/potato/pet/wave-hello.webp';
import needsYou from '../../assets/potato/pet/needs-you.webp';
import celebrate from '../../assets/potato/pet/celebrate.webp';
import walkLeft from '../../assets/potato/pet/walk-left.webp';
import walkRight from '../../assets/potato/pet/walk-right.webp';
import dragged from '../../assets/potato/pet/dragged.webp';
import land from '../../assets/potato/pet/land.webp';
import talk from '../../assets/potato/pet/talk.webp';
import type { SpriteName } from './petModel';

export const SPRITE_SHEETS: Record<SpriteName, string> = {
  idle,
  blink,
  sleepy,
  sleep,
  'wave-hello': waveHello,
  'needs-you': needsYou,
  celebrate,
  'walk-left': walkLeft,
  'walk-right': walkRight,
  dragged,
  land,
  talk,
};
