import { useEffect, useRef } from 'react';
import { FPS, SPRITE_FRAMES, type PetPlay, type SpriteName } from './petModel';
import { SPRITE_SHEETS } from './petSprites';

/** Position of frame `index` on a sheet of `count` frames laid side by side, as a CSS percentage. */
export function framePosition(index: number, count: number): string {
  return count <= 1 ? '0%' : `${(index / (count - 1)) * 100}%`;
}

/** The frame to show `elapsedMs` after a state began. */
export function frameAt(elapsedMs: number, count: number, play: PetPlay): number {
  if (play === 'still' || count <= 1) return 0;
  const step = Math.floor((Math.max(0, elapsedMs) / 1000) * FPS);
  return play === 'once' ? Math.min(step, count - 1) : step % count;
}

interface Props {
  sprite: SpriteName;
  play: PetPlay;
  /** Side of the picture in px. */
  size: number;
}

/**
 * One state of the Potato. A still picture costs nothing: requestAnimationFrame runs only while frames are
 * changing, and a "once" state stops on its last frame. The frame is written straight to the element (no React
 * render per frame).
 */
export function PetSprite({ sprite, play, size }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const count = SPRITE_FRAMES[sprite];

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = -1;
    const show = (index: number) => {
      if (index === frame) return;
      frame = index;
      el.style.backgroundPositionX = framePosition(index, count);
      el.dataset.frame = String(index);
    };
    show(0);
    if (play === 'still' || count <= 1 || typeof requestAnimationFrame !== 'function') return;
    let raf = 0;
    let start: number | null = null;
    const step = (now: number) => {
      start ??= now;
      const index = frameAt(now - start, count, play);
      show(index);
      if (play === 'once' && index >= count - 1) return;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [sprite, play, count]);

  return (
    <div
      ref={ref}
      className="pet-sprite"
      data-sprite={sprite}
      data-play={play}
      aria-hidden="true"
      style={{ width: size, height: size, backgroundImage: `url(${SPRITE_SHEETS[sprite]})`, backgroundSize: `${count * 100}% 100%` }}
    />
  );
}
