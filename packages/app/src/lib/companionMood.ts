// The companion's mood, from data the app already has: how many agents wait for the person or work, whether a run
// just finished, the companion's own state, and the time of day. No new data, no new calls. The face is a Potato
// pose (components/cockpit/PotatoFace.tsx); the line is a translation key plus its values.
import { useEffect, useRef, useState } from 'react';
import type { PotatoState } from '../components/cockpit/PotatoFace';
import type { CompanionState } from './companion';
import type { MessageKey } from '../i18n';

export interface MoodInput {
  /** The companion's own state from the backend. */
  state: CompanionState;
  /** Agents waiting for the person (the same number as the Inbox badge). */
  waiting: number;
  /** The name of the agent that waits, when exactly one does. */
  waitingName?: string | null;
  /** Agents working right now. */
  working: number;
  /** All the agents in the sidebar. */
  agents: number;
  /** Notes the companion wants the person to look at. */
  notes: number;
  /** A run finished a moment ago. */
  justFinished: boolean;
  /** Local hour, 0..23. */
  hour: number;
}

export interface Mood {
  face: PotatoState;
  /** `key` and `vars` go straight to t(). */
  key: MessageKey;
  vars?: Record<string, string | number>;
  /** The row is tinted and the line is bold: the person is needed. */
  urgent: boolean;
}

/** Late evening and night: the companion is sleepy, then asleep. */
export const isSleepyHour = (hour: number): boolean => hour >= 21 || hour < 7;
export const isAsleepHour = (hour: number): boolean => hour >= 23 || hour < 5;

export function companionMood(i: MoodInput): Mood {
  if (i.state === 'stopped') return { face: 'sleep', key: 'companion.mood.stopped', urgent: false };
  if (i.state === 'starting') return { face: 'wave-hello', key: 'companion.mood.starting', urgent: false };
  if (i.waiting > 0 || i.state === 'needs_you') {
    if (i.waiting === 1 && i.waitingName) return { face: 'needs-you', key: 'companion.mood.oneNeedsYou', vars: { name: i.waitingName }, urgent: true };
    if (i.waiting > 1) return { face: 'needs-you', key: 'companion.mood.manyNeedYou', vars: { count: i.waiting }, urgent: true };
    return { face: 'needs-you', key: 'companion.mood.needsYou', urgent: true };
  }
  if (i.justFinished) return { face: 'celebrate', key: 'companion.mood.done', urgent: false };
  if (i.working > 0 || i.state === 'working') {
    return i.agents > 0
      ? { face: 'working', key: 'companion.mood.watching', vars: { count: i.agents }, urgent: false }
      : { face: 'working', key: 'companion.mood.working', urgent: false };
  }
  if (isSleepyHour(i.hour) || i.state === 'sleeping') {
    const asleep = isAsleepHour(i.hour) || i.state === 'sleeping';
    if (i.notes > 0) return { face: asleep ? 'sleep' : 'sleepy', key: 'companion.mood.sleepyNotes', vars: { count: i.notes }, urgent: false };
    return { face: asleep ? 'sleep' : 'sleepy', key: 'companion.mood.sleepy', urgent: false };
  }
  if (i.agents > 0) return { face: 'idle', key: 'companion.mood.watching', vars: { count: i.agents }, urgent: false };
  return { face: 'idle', key: 'companion.mood.here', urgent: false };
}

/** True for a few seconds after the number of working agents drops to zero (a run finished). */
export function useJustFinished(working: number, holdMs = 6000): boolean {
  const before = useRef(working);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const was = before.current;
    before.current = working;
    if (was > 0 && working === 0) {
      setOn(true);
      const id = setTimeout(() => setOn(false), holdMs);
      return () => clearTimeout(id);
    }
    if (working > 0) setOn(false);
    return undefined;
  }, [working, holdMs]);
  return on;
}

/** The local hour, checked again every minute, so the face gets sleepy at night without a reload. */
export function useLocalHour(): number {
  const [hour, setHour] = useState(() => new Date().getHours());
  useEffect(() => {
    const id = setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => clearInterval(id);
  }, []);
  return hour;
}
