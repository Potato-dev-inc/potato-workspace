// The phone's motion: one small spring of our own, the Full / Reduced choice, and the `data-motion` mark on the `.ph` shell.
// The spring is critically damped and set by a time, so it never bounces: x(t) = (x0 + (v0 + w*x0) t) e^(-w t), w = 2 pi / duration.
// Reduced motion comes from two places, the phone's own switch and the Settings row; either one turns it on. Reduced means short
// fades (150 ms), not "all off": styles/phone.css reads `.ph[data-motion='reduce']`, and every spring jumps to its end.
// The choice is kept on this phone only (localStorage), like the theme and the text size.
import { useEffect, useRef, useState, type RefObject } from 'react';

export type PhoneMotion = 'full' | 'reduce';
export const PHONE_MOTION_KEY = 'potato.phone.motion.v1';
export const PHONE_MOTION_EVENT = 'potato:phone-motion';

/** Spring durations in seconds (the plan's motion spec). The CSS tokens in styles/phone.css carry the matching times. */
export const SPRING = {
  dock: { duration: 0.4 },
  panelOpen: { duration: 0.34 },
  panelClose: { duration: 0.28 },
  cardOpen: { duration: 0.42 },
  cardClose: { duration: 0.3 },
} as const;
/** Reduced motion turns slides into fades of this length (ms). */
export const REDUCED_FADE_MS = 150;

export function parsePhoneMotion(raw: unknown): PhoneMotion {
  return raw === 'reduce' ? 'reduce' : 'full';
}

export function readPhoneMotion(): PhoneMotion {
  try {
    return parsePhoneMotion(localStorage.getItem(PHONE_MOTION_KEY));
  } catch {
    return 'full';
  }
}

export function setPhoneMotion(motion: PhoneMotion): void {
  try {
    localStorage.setItem(PHONE_MOTION_KEY, motion);
  } catch {
    /* storage blocked: the choice still applies for this visit */
  }
  window.dispatchEvent(new CustomEvent<PhoneMotion>(PHONE_MOTION_EVENT, { detail: motion }));
}

function systemReduces(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** True when either the Settings row or the phone's own switch asks for less motion. Pass an element to read its shell's mark. */
export function prefersReduced(el?: Element | null): boolean {
  const shell = el?.closest?.('.ph') ?? document.querySelector('.ph');
  if (shell) return (shell as HTMLElement).dataset.motion === 'reduce';
  return readPhoneMotion() === 'reduce' || systemReduces();
}

/** Put `data-motion="reduce"` on the `.ph` shell that holds `ref`, and follow changes (this tab, another tab, the phone's switch). */
export function usePhoneMotion(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const shell = ref.current?.closest<HTMLElement>('.ph') ?? ref.current;
    if (!shell) return;
    const apply = () => {
      if (readPhoneMotion() === 'reduce' || systemReduces()) shell.dataset.motion = 'reduce';
      else delete shell.dataset.motion;
    };
    apply();
    const onStorage = (event: StorageEvent) => {
      if (event.key === PHONE_MOTION_KEY) apply();
    };
    let media: MediaQueryList | null = null;
    try {
      media = window.matchMedia('(prefers-reduced-motion: reduce)');
      media.addEventListener?.('change', apply);
    } catch {
      media = null;
    }
    window.addEventListener(PHONE_MOTION_EVENT, apply);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(PHONE_MOTION_EVENT, apply);
      window.removeEventListener('storage', onStorage);
      media?.removeEventListener?.('change', apply);
    };
  }, [ref]);
}

export interface SpringOptions {
  /** Seconds to settle (the time the motion takes to be nearly done). */
  duration: number;
  /** Starting speed in value units per second (keeps the finger's speed when a drag is let go). */
  velocity?: number;
  /** Stop when this close to the end. */
  rest?: number;
}

/** Where a critically damped spring is at time `t` seconds. Never bounces when `velocity` points to the end or is 0. */
export function springValue(from: number, to: number, t: number, duration: number, velocity = 0): number {
  const w = (2 * Math.PI) / Math.max(0.001, duration);
  const x0 = from - to;
  const time = Math.max(0, t);
  return to + (x0 + (velocity + w * x0) * time) * Math.exp(-w * time);
}

/** True when the spring has settled: close enough to the end, and past a third of its time (so a fast start is not cut short). */
export function springSettled(from: number, to: number, t: number, o: SpringOptions): boolean {
  const rest = o.rest ?? 0.5;
  if (t > o.duration * 4) return true;
  return t > o.duration * 0.35 && Math.abs(springValue(from, to, t, o.duration, o.velocity) - to) < rest;
}

export interface SpringRun {
  stop(): void;
}

/** Run a spring with requestAnimationFrame. Reduced motion paints the end at once. Can be stopped (and a new one started from the last value). */
export function startSpring(
  from: number,
  to: number,
  o: SpringOptions,
  paint: (v: number) => void,
  done?: () => void,
  reduced: boolean = prefersReduced(),
): SpringRun {
  if (reduced || from === to) {
    paint(to);
    done?.();
    return { stop() {} };
  }
  const t0 = performance.now();
  let raf = 0;
  let dead = false;
  const frame = (now: number) => {
    if (dead) return;
    const t = Math.max(0, (now - t0) / 1000);
    if (springSettled(from, to, t, o)) {
      paint(to);
      done?.();
      return;
    }
    paint(springValue(from, to, t, o.duration, o.velocity));
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return {
    stop() {
      dead = true;
      cancelAnimationFrame(raf);
    },
  };
}

/** A number that follows `target` on a spring. Starts at `target`; when `target` changes it turns around from where it is. */
export function useSpring(target: number, o: SpringOptions): number {
  const [value, setValue] = useState(target);
  const last = useRef(target);
  const duration = o.duration;
  const rest = o.rest;
  useEffect(() => {
    const run = startSpring(last.current, target, { duration, rest }, (v) => {
      last.current = v;
      setValue(v);
    });
    return () => run.stop();
  }, [target, duration, rest]);
  return value;
}
