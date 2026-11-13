# Potato artwork

Potato artwork (c) the Puppet Master founder

Copied from the Potato animation pack (design/potato).

- animated/<state>.svg: self-animating (CSS only), used as an img.
- still/<state>.svg: the first frame, shown when the person prefers reduced motion.
- icons/icon.svg: the static mark.

## pet/

Desktop Potato (Labs): one sprite sheet per state, frames side by side, 160 px each, 12 fps. Made from the pet pack
(design/potato/exports/pet) by scaling every frame down. Potato artwork (c) the Puppet Master founder.

States used: idle, blink, sleepy, sleep, wave-hello, needs-you, celebrate, walk-left, walk-right, dragged, land, talk.
Frame counts are in `components/pet/petModel.ts` (`SPRITE_FRAMES`).
