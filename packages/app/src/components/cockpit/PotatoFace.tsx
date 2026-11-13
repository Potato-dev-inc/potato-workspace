// The real Potato art (assets/potato). Each state is an animated SVG used as an img (the animation is CSS inside the
// file, no script). When the person prefers reduced motion (the system setting, or "Less motion" in Settings), the still first frame shows.
import { useComfort } from '../../lib/comfort/store';
import idle from '../../assets/potato/animated/idle.svg';
import blink from '../../assets/potato/animated/blink.svg';
import working from '../../assets/potato/animated/working.svg';
import needsYou from '../../assets/potato/animated/needs-you.svg';
import sleepy from '../../assets/potato/animated/sleepy.svg';
import sleep from '../../assets/potato/animated/sleep.svg';
import celebrate from '../../assets/potato/animated/celebrate.svg';
import error from '../../assets/potato/animated/error.svg';
import happy from '../../assets/potato/animated/happy.svg';
import loading from '../../assets/potato/animated/loading.svg';
import waveHello from '../../assets/potato/animated/wave-hello.svg';
import stillIdle from '../../assets/potato/still/idle.svg';
import stillBlink from '../../assets/potato/still/blink.svg';
import stillWorking from '../../assets/potato/still/working.svg';
import stillNeedsYou from '../../assets/potato/still/needs-you.svg';
import stillSleepy from '../../assets/potato/still/sleepy.svg';
import stillSleep from '../../assets/potato/still/sleep.svg';
import stillCelebrate from '../../assets/potato/still/celebrate.svg';
import stillError from '../../assets/potato/still/error.svg';
import stillHappy from '../../assets/potato/still/happy.svg';
import stillLoading from '../../assets/potato/still/loading.svg';
import stillWaveHello from '../../assets/potato/still/wave-hello.svg';

export type PotatoState = 'idle' | 'blink' | 'working' | 'needs-you' | 'sleepy' | 'sleep' | 'celebrate' | 'error' | 'happy' | 'loading' | 'wave-hello';

const ART: Record<PotatoState, { moving: string; still: string }> = {
  idle: { moving: idle, still: stillIdle },
  blink: { moving: blink, still: stillBlink },
  working: { moving: working, still: stillWorking },
  'needs-you': { moving: needsYou, still: stillNeedsYou },
  sleepy: { moving: sleepy, still: stillSleepy },
  sleep: { moving: sleep, still: stillSleep },
  celebrate: { moving: celebrate, still: stillCelebrate },
  error: { moving: error, still: stillError },
  happy: { moving: happy, still: stillHappy },
  loading: { moving: loading, still: stillLoading },
  'wave-hello': { moving: waveHello, still: stillWaveHello },
};

/** Potato in one state. Decorative by default (the text next to it says what it means); pass `label` to name it. */
export function PotatoFace({ state = 'idle', size = 24, className, label, mark }: { state?: PotatoState; size?: number; className?: string; label?: string; mark?: boolean }) {
  const art = ART[state];
  // "Less motion" in Settings (this computer) shows the still frame, just as the system's own setting does.
  const [comfort] = useComfort();
  return (
    <picture>
      <source media="(prefers-reduced-motion: reduce)" srcSet={art.still} />
      <img
        src={comfort.lessMotion ? art.still : art.moving}
        data-still={comfort.lessMotion ? '' : undefined}
        width={size}
        height={size}
        className={className}
        alt={label ?? ''}
        aria-hidden={label ? undefined : true}
        data-mark={mark ? 'potato' : undefined}
        data-potato-state={state}
        draggable={false}
      />
    </picture>
  );
}
