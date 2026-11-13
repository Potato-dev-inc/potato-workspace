// Desktop Potato: what the pet does. Pure: no timers, no window, no DOM. Every function takes the time it is
// asked at, so the rules are tested with plain numbers. The hook (usePetController) feeds it real events and
// sets one timer for the next deadline, so an idle pet wakes nothing at all.

/** Frames per state in the sheets (one sheet per state in assets/potato/pet). All play at `FPS`. */
export const SPRITE_FRAMES = {
  idle: 24,
  blink: 6,
  sleepy: 24,
  sleep: 24,
  'wave-hello': 24,
  'needs-you': 24,
  celebrate: 24,
  'walk-left': 12,
  'walk-right': 12,
  dragged: 12,
  land: 9,
  talk: 12,
} as const;

export type SpriteName = keyof typeof SPRITE_FRAMES;
export const FPS = 12;

/** How a state is drawn: one still frame, once through, or round and round. */
export type PetPlay = 'still' | 'once' | 'loop';

// ---- timing (ms) ----
/** Nothing happened for this long: sleepy, then asleep. */
export const SLEEPY_AFTER_MS = 300_000;
export const SLEEP_AFTER_MS = 600_000;
export const WAVE_MS = 2_000;
/** After the wave, the needs-you loop plays this long, then rests on one frame. */
export const NEEDS_ANIM_MS = 6_000;
/** While an agent still waits, the pet nudges (plays the loop again) this often. */
export const NUDGE_MS = 45_000;
export const CELEBRATE_MS = 4_000;
export const DONE_BUBBLE_MS = 6_000;
export const SAY_MS = 6_000;
export const LAND_MS = 750;
export const BLINK_MS = 500;
/** "Later" hides a needs-you bubble for this long. */
export const LATER_MS = 10 * 60_000;

export interface PetNeed {
  /** Stable key of the attention item (`approval:pane-1`). */
  key: string;
  paneId?: string;
  /** The agent's plain name, as the sidebar shows it. */
  agent: string;
}

export interface PetBubble {
  kind: 'needs' | 'done' | 'say';
  agent?: string;
  paneId?: string;
  /** Only for `say`: the words. */
  text?: string;
  /** Epoch ms when it goes away by itself; null = stays while it is true. */
  until: number | null;
}

export interface PetModel {
  /** Last time anything happened (an event, a click, a drop): sleep is measured from here. */
  lastActive: number;
  needs: PetNeed[];
  /** Need key -> epoch ms until which "Later" hides its bubble. */
  deferred: Record<string, number>;
  waveUntil: number;
  animUntil: number;
  nudgeAt: number | null;
  celebrateUntil: number;
  landUntil: number;
  blinkUntil: number;
  dragging: boolean;
  walk: { dir: 'left' | 'right'; until: number } | null;
  /** A short-lived bubble (finished, or a spoken line). The needs-you bubble is derived, not stored. */
  bubble: PetBubble | null;
  /** Quiet (the person's choice, or quiet hours): the pet sleeps and says nothing. */
  quiet: boolean;
}

export function newPet(at: number): PetModel {
  return {
    lastActive: at,
    needs: [],
    deferred: {},
    waveUntil: 0,
    animUntil: 0,
    nudgeAt: null,
    celebrateUntil: 0,
    landUntil: 0,
    blinkUntil: 0,
    dragging: false,
    walk: null,
    bubble: null,
    quiet: false,
  };
}

export type PetEvent =
  | { type: 'needs'; needs: PetNeed[] }
  | { type: 'finished'; agent: string; paneId?: string }
  | { type: 'say'; text: string }
  | { type: 'dragStart' }
  | { type: 'dragEnd' }
  | { type: 'later' }
  | { type: 'dismiss' }
  | { type: 'blink' }
  | { type: 'walkStart'; dir: 'left' | 'right'; ms: number }
  | { type: 'walkEnd' }
  | { type: 'quiet'; on: boolean }
  | { type: 'touch' }
  | { type: 'tick' };

/** The needs-you bubble: the first need that "Later" is not hiding. Null in quiet. */
export function needsBubble(m: PetModel, now: number): PetBubble | null {
  if (m.quiet) return null;
  const need = m.needs.find((n) => !((m.deferred[n.key] ?? 0) > now));
  return need ? { kind: 'needs', agent: need.agent, paneId: need.paneId, until: null } : null;
}

/** The bubble to show right now: a fresh finished/spoken line wins over the standing needs-you one. */
export function currentBubble(m: PetModel, now: number): PetBubble | null {
  if (m.quiet) return null;
  if (m.bubble && (m.bubble.until === null || m.bubble.until > now)) return m.bubble;
  return needsBubble(m, now);
}

function prune(m: PetModel, now: number): PetModel {
  let next = m;
  if (m.bubble && m.bubble.until !== null && m.bubble.until <= now) next = { ...next, bubble: null };
  const live = Object.entries(m.deferred).filter(([, until]) => until > now);
  if (live.length !== Object.keys(m.deferred).length) next = { ...next, deferred: Object.fromEntries(live) };
  if (m.walk && m.walk.until <= now) next = { ...next, walk: null };
  if (m.nudgeAt !== null && m.needs.length > 0 && m.nudgeAt <= now && !m.quiet) {
    next = { ...next, animUntil: now + NEEDS_ANIM_MS, nudgeAt: now + NUDGE_MS };
  }
  return next;
}

export function petReduce(model: PetModel, event: PetEvent, at: number): PetModel {
  const m = prune(model, at);
  switch (event.type) {
    case 'tick':
      return m;
    case 'needs': {
      const known = new Set(m.needs.map((n) => n.key));
      const fresh = event.needs.filter((n) => !known.has(n.key));
      const gone = new Set(m.needs.map((n) => n.key));
      for (const n of event.needs) gone.delete(n.key);
      const deferred = { ...m.deferred };
      for (const key of gone) delete deferred[key];
      const base = { ...m, needs: event.needs, deferred, nudgeAt: event.needs.length ? (m.nudgeAt ?? at + NUDGE_MS) : null };
      if (m.quiet || fresh.length === 0) return base;
      // Someone new needs the person: wave, then the needs-you loop, and the walk stops.
      return { ...base, lastActive: at, waveUntil: at + WAVE_MS, animUntil: at + WAVE_MS + NEEDS_ANIM_MS, nudgeAt: at + NUDGE_MS, walk: null };
    }
    case 'finished':
      if (m.quiet) return m;
      return {
        ...m,
        lastActive: at,
        celebrateUntil: at + CELEBRATE_MS,
        walk: null,
        bubble: { kind: 'done', agent: event.agent, paneId: event.paneId, until: at + DONE_BUBBLE_MS },
      };
    case 'say':
      if (m.quiet) return m;
      return { ...m, lastActive: at, bubble: { kind: 'say', text: event.text, until: at + SAY_MS } };
    case 'dragStart':
      return { ...m, dragging: true, walk: null, lastActive: at };
    case 'dragEnd':
      return { ...m, dragging: false, landUntil: at + LAND_MS, lastActive: at };
    case 'later': {
      const need = m.needs.find((n) => !((m.deferred[n.key] ?? 0) > at));
      const deferred = need ? { ...m.deferred, [need.key]: at + LATER_MS } : m.deferred;
      return { ...m, deferred, bubble: m.bubble?.kind === 'say' ? m.bubble : null };
    }
    case 'dismiss':
      return { ...m, bubble: null };
    case 'blink':
      return { ...m, blinkUntil: at + BLINK_MS };
    case 'walkStart':
      return canWalk(m, at) ? { ...m, walk: { dir: event.dir, until: at + event.ms } } : m;
    case 'walkEnd':
      return { ...m, walk: null };
    case 'quiet':
      if (event.on === m.quiet) return m;
      return event.on
        ? { ...m, quiet: true, bubble: null, walk: null }
        : { ...m, quiet: false, lastActive: at };
    case 'touch':
      return { ...m, lastActive: at };
  }
}

/** Walking only happens in plain daylight: awake, nothing to say, nobody holding it. */
export function canWalk(m: PetModel, now: number): boolean {
  return !m.quiet && !m.dragging && m.walk === null && m.needs.length === 0 && currentBubble(m, now) === null
    && now >= m.celebrateUntil && now >= m.landUntil && now - m.lastActive < SLEEPY_AFTER_MS;
}

export interface PetView {
  sprite: SpriteName;
  play: PetPlay;
  bubble: PetBubble | null;
  /** Number of agents waiting on the person (also in quiet: the label still says so). */
  needsCount: number;
  /** The pet is resting (sleepy, asleep or quiet): safe moment for nothing, never for walking. */
  resting: boolean;
  /** Quiet is on: it sleeps and says nothing. */
  quiet: boolean;
}

/** What to draw at `now`. Less motion: every state is one still frame. */
export function petView(model: PetModel, now: number, lessMotion = false): PetView {
  const m = prune(model, now);
  const bubble = currentBubble(m, now);
  const base = { bubble, needsCount: m.needs.length, quiet: m.quiet };
  const pick = (sprite: SpriteName, play: PetPlay, resting = false): PetView => ({
    ...base,
    sprite,
    play: lessMotion ? 'still' : play,
    resting,
  });
  if (m.quiet) return pick('sleep', 'still', true);
  if (m.dragging) return pick('dragged', 'loop');
  if (now < m.landUntil) return pick('land', 'once');
  if (m.walk) return pick(m.walk.dir === 'left' ? 'walk-left' : 'walk-right', 'loop');
  if (now < m.celebrateUntil) return pick('celebrate', 'loop');
  if (m.needs.length > 0) {
    if (now < m.waveUntil) return pick('wave-hello', 'once');
    return pick('needs-you', now < m.animUntil ? 'loop' : 'still');
  }
  if (bubble?.kind === 'say') return pick('talk', 'loop');
  if (now < m.blinkUntil) return pick('blink', 'once');
  const idleFor = now - m.lastActive;
  if (idleFor >= SLEEP_AFTER_MS) return pick('sleep', 'still', true);
  if (idleFor >= SLEEPY_AFTER_MS) return pick('sleepy', 'still', true);
  return pick('idle', 'still');
}

/** The next moment the picture or the bubble changes by itself, after `now`. Null: nothing is scheduled. */
export function nextDeadline(model: PetModel, now: number): number | null {
  const m = model;
  const times: number[] = [m.waveUntil, m.animUntil, m.celebrateUntil, m.landUntil, m.blinkUntil];
  if (m.bubble?.until) times.push(m.bubble.until);
  if (m.walk) times.push(m.walk.until);
  if (m.nudgeAt !== null && m.needs.length > 0 && !m.quiet) times.push(m.nudgeAt);
  for (const until of Object.values(m.deferred)) times.push(until);
  if (!m.quiet && m.needs.length === 0 && !m.dragging) times.push(m.lastActive + SLEEPY_AFTER_MS, m.lastActive + SLEEP_AFTER_MS);
  const future = times.filter((t) => t > now);
  return future.length ? Math.min(...future) : null;
}
